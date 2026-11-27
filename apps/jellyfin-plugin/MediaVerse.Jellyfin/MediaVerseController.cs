using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace MediaVerse.Jellyfin;

public sealed class NewProfile
{
    public string? Name { get; set; }
}

public sealed class Change
{
    /// <summary>The revision the sender read and changed.</summary>
    public long Revision { get; set; }

    public JsonNode? Data { get; set; }
}

/// <summary>
/// The plugin's addresses, all under /MediaVerse and all for signed-in apps only. Any user signed in to the server may
/// use every profile: profiles are not accounts.
/// </summary>
[ApiController]
[Authorize]
[Route("MediaVerse")]
public class MediaVerseController(ILogger<MediaVerseController> logger) : ControllerBase
{
    private static Plugin Current => Plugin.Instance ?? throw new InvalidOperationException("The plugin is not loaded.");

    private static DocumentStore Store => new(Current.DataFolderPath);

    [HttpGet("Info")]
    public ActionResult Info() => Ok(new { Api = 1, Version = Current.Version.ToString(), Uploads = Current.Configuration.AllowUploads });

    [HttpGet("Profiles")]
    public Task<ActionResult> Profiles() => Answer(async () => await Store.List().ConfigureAwait(false));

    [HttpPost("Profiles")]
    public Task<ActionResult> Create([FromBody] NewProfile body) => Answer(async () => await Store.Create(body.Name).ConfigureAwait(false));

    [HttpGet("Profiles/{id}")]
    public Task<ActionResult> Profile(string id) => Answer(async () => await Store.Get(Own(id)).ConfigureAwait(false));

    [HttpPut("Profiles/{id}")]
    public Task<ActionResult> Save(string id, [FromBody] Change body) => Answer(async () => await Store.Put(Own(id), body.Revision, body.Data).ConfigureAwait(false));

    [HttpDelete("Profiles/{id}")]
    public Task<ActionResult> Remove(string id) => Answer(async () => new { Removed = await Store.Remove(Own(id)).ConfigureAwait(false) });

    [HttpGet("Flags")]
    public Task<ActionResult> Flags() => Answer(async () => await Store.Get("flags").ConfigureAwait(false));

    [HttpPut("Flags")]
    public Task<ActionResult> SaveFlags([FromBody] Change body) => Answer(async () => await Store.Put("flags", body.Revision, body.Data).ConfigureAwait(false));

    [HttpPost("Upload")]
    [DisableRequestSizeLimit] // songs are larger than the server's usual limit; the size is checked here
    public Task<ActionResult> Upload([FromQuery] string? path) => Answer(async () =>
    {
        var settings = Current.Configuration;
        if (!settings.AllowUploads)
        {
            throw new Refused(403, "New music is not accepted: the administrator can allow it in the plugin's settings.");
        }

        var parts = IncomingMusic.CleanPath(path) ?? throw new Refused(400, "That is not a song file that is accepted.");
        var length = Request.ContentLength ?? throw new Refused(411, "The size of the song is needed.");
        if (length is <= 0 or > IncomingMusic.MaxBytes)
        {
            throw new Refused(413, "That file is empty or too large.");
        }

        var folder = string.IsNullOrWhiteSpace(settings.IncomingFolder)
            ? System.IO.Path.Combine(Current.DataFolderPath, "Incoming")
            : settings.IncomingFolder;
        var already = await IncomingMusic.Receive(Request.Body, length, folder, parts, HttpContext.RequestAborted).ConfigureAwait(false);
        return new { Ok = true, Already = already };
    });

    /// <summary>The shared list has its own address and is not a profile.</summary>
    private static string Own(string id) => id == "flags" ? throw new Refused(404, "No such profile.") : id;

    private async Task<ActionResult> Answer<T>(Func<Task<T>> work)
    {
        try
        {
            return Ok(await work().ConfigureAwait(false));
        }
        catch (Refused refused)
        {
            return StatusCode(refused.Status, new { Message = refused.Message });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // The server's own paths are for its log, not for the app.
            logger.LogError(error, "MediaVerse Sync could not read or write its files");
            return StatusCode(500, new { Message = "The server could not read or write the file. Its log says why." });
        }
    }
}
