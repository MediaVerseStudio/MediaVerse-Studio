using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace MediaVerse.Jellyfin;

/// <summary>What the server's administrator chooses.</summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Whether signed-in apps may send new music to the incoming folder. Off until switched on.</summary>
    public bool AllowUploads { get; set; }

    /// <summary>Where new music waits. Empty: a folder in the plugin's own data folder.</summary>
    public string IncomingFolder { get; set; } = string.Empty;
}

/// <summary>
/// MediaVerse Studio on a Jellyfin server: its own profiles (no Jellyfin users needed), a shared list of problem
/// tracks, and a place for new music, all through the server's ordinary plugin system. Its data lives in the plugin's
/// own folder; nothing of Jellyfin's is written to.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "MediaVerse Sync";

    public override string Description => "Profiles, problem tracks and new music for MediaVerse Studio.";

    public override Guid Id => Guid.Parse("7c2b6f0e-3d1a-4f7e-9a57-2f4a1c9d8e31");

    public IEnumerable<PluginPageInfo> GetPages() =>
    [
        new PluginPageInfo { Name = "MediaVerseSync", EmbeddedResourcePath = GetType().Namespace + ".settings.html" },
    ];
}
