// The independent and non-profit services that MediaVerse Studio's lookups lean on, and where to help them (owner, 2026-11-25: instead of a donation link for
// this program, which is free and asks for nothing, people are pointed at the services that need the money). Shown in Settings > About; the README and the website
// carry the same list. Each address is on the allow-list of sites the program may open (electron/external-links.js). Only services that are run by an individual
// or a non-profit and have a page for gifts are listed: AcoustID (a company), Discogs, iTunes and Deezer (companies) and LAME (no donation page) are not.

export type SupportLink = { name: string; what: string; label: string; url: string };

export const SUPPORT_INTRO =
  "MediaVerse Studio is free and has no donation link. The disc, album, cover and lyric details it fills in come from services run by individuals and non-profits who depend on gifts. If you would like to give something back, please consider them.";

export const SUPPORT_LINKS: SupportLink[] = [
  { name: "gnudb", what: "A free CD database run by one person, free of advertising and kept going by donations. It is the second opinion after MusicBrainz when you rip a disc.", label: "Donate to gnudb", url: "https://gnudb.org/donate.php" },
  { name: "MusicBrainz (MetaBrainz Foundation)", what: "The open music encyclopedia behind the disc and album lookups, run by a non-profit foundation.", label: "Support MetaBrainz", url: "https://metabrainz.org/donate" },
  { name: "Internet Archive", what: "Stores the pictures of the Cover Art Archive that the program finds for your albums.", label: "Support the Internet Archive", url: "https://archive.org/donate" },
  { name: "Wikimedia", what: "Its Commons library is where artist photos come from.", label: "Support Wikimedia", url: "https://donate.wikimedia.org/" },
  { name: "Jellyfin", what: "The volunteer-built media server this program works with; its site explains how to help.", label: "Visit Jellyfin", url: "https://jellyfin.org/" },
  { name: "LRCLIB", what: "A free community lyrics database. It has no donation page we could find, so please use it kindly.", label: "Visit LRCLIB", url: "https://lrclib.net/" },
];

/** Where questions, problems and ideas go. */
export const ISSUE_BOARD = "https://github.com/MediaVerseStudio/MediaVerse-Studio/issues/new/choose";
