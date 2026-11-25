// Pinned albums (Zune-style Pins): the list held by the page, so the library and Home can show and change it.

import { invoke } from "./desktop-bridge";
import type { Pin } from "./home-format";

export type PinStore = {
  has: (folder: string) => boolean;
  all: () => Pin[];
  reload: () => Promise<void>;
  toggle: (folder: string, album: string, artist: string) => Promise<void>;
  onChange: (listener: () => void) => void;
};

export function createPinStore(): PinStore {
  let pins: Pin[] = [];
  const listeners: (() => void)[] = [];
  const apply = (reply: { pins: Pin[] }): void => {
    pins = reply.pins;
    for (const listener of listeners) listener();
  };
  return {
    has: (folder) => pins.some((p) => p.folder === folder),
    all: () => pins,
    reload: async () => apply(await invoke<{ pins: Pin[] }>("list_pins")),
    toggle: async (folder, album, artist) => {
      const pinned = !pins.some((p) => p.folder === folder);
      apply(await invoke<{ pins: Pin[] }>("set_pin", { folder, pinned, album, artist }));
    },
    onChange: (listener) => listeners.push(listener),
  };
}
