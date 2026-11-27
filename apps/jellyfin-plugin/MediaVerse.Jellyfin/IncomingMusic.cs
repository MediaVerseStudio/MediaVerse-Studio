using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace MediaVerse.Jellyfin;

/// <summary>
/// New music sent by an app: the same rules as the computer's (web/app/electron/share-sync.js). Only plain song paths,
/// only inside the incoming folder, and never over a file that is already there.
/// </summary>
public static partial class IncomingMusic
{
    public const long MaxBytes = 1536L * 1024 * 1024;

    private static readonly HashSet<string> Kinds = new(StringComparer.OrdinalIgnoreCase)
        { ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma", ".wv" };

    [GeneratedRegex("[\\x00-\\x1f<>:\"\\\\|?*]")]
    private static partial Regex Forbidden();

    [GeneratedRegex("^(con|prn|aux|nul|com\\d|lpt\\d)(\\.|$)", RegexOptions.IgnoreCase)]
    private static partial Regex Reserved();

    /// <summary>"Artist/Album/01 Song.mp3" as its parts, or null when it is not a plain relative path to a song.</summary>
    public static string[]? CleanPath(string? path)
    {
        var parts = (path ?? string.Empty).Split('/');
        if (parts.Length > 6)
        {
            return null;
        }

        foreach (var part in parts)
        {
            // A part ending in a dot or space (".." among them) is refused outright.
            if (part.Length is 0 or > 120 || Forbidden().IsMatch(part) || Reserved().IsMatch(part) || part.EndsWith('.') || part.EndsWith(' '))
            {
                return null;
            }
        }

        return Kinds.Contains(Path.GetExtension(parts[^1])) ? parts : null;
    }

    /// <summary>Receives a song of exactly <paramref name="length"/> bytes. True when the same file was already there.</summary>
    public static async Task<bool> Receive(Stream body, long length, string folder, string[] parts, CancellationToken cancel)
    {
        Directory.CreateDirectory(folder);
        // Part files left by a server that stopped while receiving, a day old or more.
        foreach (var old in Directory.EnumerateFiles(folder, ".receiving-*.part"))
        {
            if (DateTime.UtcNow - File.GetLastWriteTimeUtc(old) > TimeSpan.FromDays(1))
            {
                File.Delete(old);
            }
        }

        var temp = Path.Combine(folder, $".receiving-{Guid.NewGuid():N}.part");
        try
        {
            long got = 0;
            await using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write))
            {
                var buffer = new byte[81920];
                int n;
                while ((n = await body.ReadAsync(buffer, cancel).ConfigureAwait(false)) > 0)
                {
                    got += n;
                    if (got > length)
                    {
                        throw new Refused(400, "More was sent than announced.");
                    }

                    await output.WriteAsync(buffer.AsMemory(0, n), cancel).ConfigureAwait(false);
                }
            }

            if (got != length)
            {
                throw new Refused(400, "The song was cut short on the way.");
            }

            return Place(temp, folder, parts);
        }
        finally
        {
            File.Delete(temp);
        }
    }

    private static bool Place(string temp, string folder, string[] parts)
    {
        var directory = Path.Combine([folder, .. parts[..^1]]);
        Directory.CreateDirectory(directory);
        var extension = Path.GetExtension(parts[^1]);
        var stem = parts[^1][..^extension.Length];
        for (var n = 1; n < 100; n++)
        {
            var target = Path.Combine(directory, n == 1 ? parts[^1] : $"{stem} ({n}){extension}");
            if (!File.Exists(target))
            {
                try
                {
                    File.Copy(temp, target, false);
                    return false;
                }
                catch (IOException) when (File.Exists(target))
                {
                    // taken between the look and the copy: compared below
                }
            }

            if (Same(temp, target))
            {
                return true;
            }
        }

        throw new Refused(409, "There are too many files with that name.");
    }

    private static bool Same(string first, string second)
    {
        if (new FileInfo(first).Length != new FileInfo(second).Length)
        {
            return false;
        }

        using var a = File.OpenRead(first);
        using var b = File.OpenRead(second);
        return SHA256.HashData(a).AsSpan().SequenceEqual(SHA256.HashData(b));
    }
}
