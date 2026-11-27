using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MediaVerse.Jellyfin;

/// <summary>One stored document: a profile, or the shared list of problem tracks.</summary>
public sealed record Document(string Id, string Name, long Revision, JsonNode? Data);

/// <summary>A change refused, with the HTTP status that says why.</summary>
public sealed class Refused(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

/// <summary>
/// Profiles and shared lists as one JSON file each, written whole and then moved into place. A write names the revision
/// it was made from and is refused when the document has moved on, so two devices cannot silently undo each other.
/// </summary>
public sealed partial class DocumentStore(string folder)
{
    private const int MaxProfiles = 50;
    private const int MaxBytes = 4 * 1024 * 1024;
    private static readonly SemaphoreSlim Turn = new(1, 1);

    private string Profiles => Path.Combine(folder, "profiles");

    private string Removed => Path.Combine(folder, "removed");

    [GeneratedRegex("^[0-9a-f]{32}$")]
    private static partial Regex ProfileId();

    private string PathOf(string id) => id == "flags"
        ? Path.Combine(folder, "shared-flags.json")
        : ProfileId().IsMatch(id) ? Path.Combine(Profiles, id + ".json") : throw new Refused(404, "No such profile.");

    private static Document? Read(string file)
    {
        if (!File.Exists(file))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<Document>(File.ReadAllBytes(file));
        }
        catch (JsonException)
        {
            // Never read as empty: the next write would then replace what could still be repaired by hand.
            throw new Refused(500, "A stored document is damaged. It has been left as it is.");
        }
    }

    private static void Write(string file, Document document)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(document);
        if (bytes.Length > MaxBytes)
        {
            throw new Refused(413, "That is too much to store.");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temp = file + ".tmp";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, file, true);
    }

    /// <summary>Every profile that can be read: one damaged file must not take the others out of use.</summary>
    private IEnumerable<Document> All() => Directory.Exists(Profiles)
        ? Directory.EnumerateFiles(Profiles, "*.json").Select(ReadIfSound).OfType<Document>()
        : [];

    private static Document? ReadIfSound(string file)
    {
        try
        {
            return Read(file);
        }
        catch (Refused)
        {
            return null;
        }
    }

    private async Task<T> InTurn<T>(Func<T> work)
    {
        await Turn.WaitAsync().ConfigureAwait(false);
        try
        {
            return work();
        }
        finally
        {
            Turn.Release();
        }
    }

    public Task<List<Document>> List() => InTurn(() => All()
        .Select(d => d with { Data = null })
        .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
        .ToList());

    public Task<Document> Get(string id) => InTurn(() => Read(PathOf(id))
        ?? (id == "flags" ? new Document("flags", "Problem tracks", 0, null) : throw new Refused(404, "No such profile.")));

    public Task<Document> Create(string? name) => InTurn(() =>
    {
        var clean = (name ?? string.Empty).Trim();
        if (clean.Length is 0 or > 40 || clean.Any(char.IsControl))
        {
            throw new Refused(400, "A profile needs a name of up to 40 characters.");
        }

        var existing = All().ToList();
        if (existing.Any(d => string.Equals(d.Name, clean, StringComparison.OrdinalIgnoreCase)))
        {
            throw new Refused(409, "There is already a profile with that name.");
        }

        if (existing.Count >= MaxProfiles)
        {
            throw new Refused(409, "There are too many profiles.");
        }

        var made = new Document(Guid.NewGuid().ToString("N"), clean, 1, null);
        Write(PathOf(made.Id), made);
        return made;
    });

    public Task<Document> Put(string id, long revision, JsonNode? data) => InTurn(() =>
    {
        var now = Read(PathOf(id))
            ?? (id == "flags" ? new Document("flags", "Problem tracks", 0, null) : throw new Refused(404, "No such profile."));
        if (now.Revision != revision)
        {
            throw new Refused(409, "Changed meanwhile: read it again.");
        }

        var next = now with { Revision = now.Revision + 1, Data = data };
        Write(PathOf(id), next);
        return next;
    });

    /// <summary>Takes a profile out of the list. Its file is kept aside, so it can be brought back by hand.</summary>
    public Task<bool> Remove(string id) => InTurn(() =>
    {
        var file = id == "flags" ? throw new Refused(400, "The shared list cannot be removed.") : PathOf(id);
        if (!File.Exists(file))
        {
            return false;
        }

        Directory.CreateDirectory(Removed);
        File.Move(file, Path.Combine(Removed, $"{id}-{DateTime.UtcNow:yyyyMMddHHmmss}.json"), false);
        return true;
    });
}
