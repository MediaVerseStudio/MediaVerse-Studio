// Settings > TV & Phone Pairing: share the library with the MediaVerse Studio apps on the home network (D38, D39): the TV app plays it,
// and the phone app keeps music, favorites, flags and playlists in step with it (D214). Off until switched on here.
// Pairing a TV or phone once takes a one-time 6-digit code that this page shows (in a window over whatever page is
// open) when the device asks. Paired devices are listed and can be removed.

import type { ShareStatus } from "./desktop-bridge";

/** "123456" as "123 456", easier to read across a room. */
export function spacedCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function initShareSettings(root: HTMLElement): void {
  const share = window.mediaVerse?.share;
  root.classList.add("settings-block");
  root.innerHTML = `
    <h3>TV &amp; Phone Pairing</h3>
    <p>The MediaVerse Studio apps can use this library in your home: a TV plays it, and a phone keeps chosen music,
      favorites, flags and playlists in step with it over Wi-Fi. While sharing is on, only devices you have paired can
      reach it; your folders are never shown, and devices outside your home network are always refused. A TV can only
      flag songs and mark favorites.</p>
    <label class="check"><input id="share-enabled" type="checkbox" /> <span>Share my library with my TVs and phones</span></label>
    <div id="share-details" hidden>
      <p class="field-hint">Press Pair a TV or phone, then on the TV choose this computer, or on the phone open Settings >
        Your computer. A 6-digit code appears here; type it on the device once. If it does not find this computer, enter
        the address <strong id="share-address"></strong> on the device.</p>
      <p><button id="share-arm" type="button">Pair a TV or phone</button></p>
      <p id="share-armed" class="field-hint" hidden>Waiting for a TV or phone to ask. This wait lasts five minutes.</p>
      <p class="field-label">Paired devices</p>
      <ul id="share-devices" class="share-devices"></ul>
      <label class="check"><input id="share-uploads" type="checkbox" /> <span>Let paired phones send new music to this computer</span></label>
      <p class="field-hint">New music waits in the folder "MediaVerse Incoming" in your user folder, for you to look over
        and add to the library. Nothing already there is written over. <button id="share-incoming" class="secondary" type="button">Open the folder</button></p>
      <div id="share-firewall" class="result-warning" hidden>
        <p>Windows Firewall is turning TVs and phones away on this network, so they cannot reach this computer.</p>
        <button id="share-firewall-allow" type="button">Let TVs and phones reach this computer</button>
        <p class="field-hint">Adds one rule: MediaVerse Studio, the sharing port only, private (home) networks only.
          Windows asks for permission first.</p>
      </div>
    </div>
    <p id="share-status" role="status"></p>`;
  const checkbox = root.querySelector<HTMLInputElement>("#share-enabled")!;
  const details = root.querySelector<HTMLElement>("#share-details")!;
  const address = root.querySelector<HTMLElement>("#share-address")!;
  const devices = root.querySelector<HTMLUListElement>("#share-devices")!;
  const status = root.querySelector<HTMLElement>("#share-status")!;
  const uploads = root.querySelector<HTMLInputElement>("#share-uploads")!;
  const firewallBox = root.querySelector<HTMLElement>("#share-firewall")!;
  const firewallAllow = root.querySelector<HTMLButtonElement>("#share-firewall-allow")!;

  if (!share) {
    checkbox.disabled = true;
    status.textContent = "Sharing is only available in the desktop program.";
    return;
  }

  const prompt = document.createElement("dialog");
  prompt.id = "pair-dialog";
  prompt.setAttribute("aria-labelledby", "pair-title");
  prompt.innerHTML = `
    <h2 id="pair-title">Pair a device</h2>
    <p id="pair-who"></p>
    <p class="pair-code" id="pair-code"></p>
    <p class="field-hint">The code works once and for five minutes. If you did not just choose this computer on a TV or
      phone, press Refuse.</p>
    <div class="dialog-actions"><button id="pair-refuse" class="secondary" type="button">Refuse</button></div>`;
  document.body.append(prompt);
  const who = prompt.querySelector<HTMLElement>("#pair-who")!;
  const pairCode = prompt.querySelector<HTMLElement>("#pair-code")!;

  function show(state: ShareStatus): void {
    checkbox.checked = state.enabled;
    details.hidden = !state.enabled;
    uploads.checked = state.uploads === true;
    address.textContent = state.addresses.length ? state.addresses.join(" or ") : "(no home network found)";
    devices.innerHTML = state.devices.length
      ? state.devices
          .map(
            (device) =>
              `<li><span>${escapeHtml(device.name)}</span> <button class="secondary" type="button" data-forget="${escapeHtml(device.id)}">Remove</button></li>`,
          )
          .join("")
      : "<li>None yet.</li>";
    status.className = state.problem ? "result-warning" : "";
    status.textContent = state.problem ? `Sharing is switched on but not working: ${state.problem}` : state.running ? "Sharing is on." : "Sharing is off.";
    if (state.enabled && !firewallChecked) {
      firewallChecked = true;
      void checkFirewall();
    }
    if (!state.enabled) firewallBox.hidden = true;

    const armed = root.querySelector<HTMLElement>("#share-armed");
    if (armed) armed.hidden = !state.pairing_armed || !!state.pairing;
    if (state.pairing) {
      who.textContent = state.pairing.phone
        ? `${state.pairing.name}, a phone, wants to keep music, favorites, flags and playlists in step with this computer. Type this code on the phone:`
        : `${state.pairing.name} wants to play your library. Type this code on the TV:`;
      pairCode.textContent = spacedCode(state.pairing.code);
      if (!prompt.open) prompt.showModal();
    } else if (prompt.open) {
      prompt.close();
    }
  }

  function run(action: () => Promise<ShareStatus>): void {
    checkbox.disabled = true;
    action()
      .then(show)
      .catch((error: unknown) => {
        status.className = "result-warning";
        status.textContent = `Could not change sharing: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        checkbox.disabled = false;
      });
  }

  // Windows Firewall (owner, 2026-11-05: the TV could not find this computer; Windows allowed it on public networks
  // only, and the home network is private). Checked once when sharing is on, and again after allowing.
  let firewallChecked = false;
  async function checkFirewall(): Promise<void> {
    const result = await share!.firewallCheck?.().catch(() => null);
    firewallBox.hidden = !result?.blocked;
  }
  root.querySelector("#share-arm")?.addEventListener("click", () => run(() => share.armPairing()));
  firewallAllow.addEventListener("click", async () => {
    firewallAllow.disabled = true;
    const open = await share.firewallAllow?.().catch(() => false);
    firewallAllow.disabled = false;
    firewallBox.hidden = !!open;
    if (!open) status.textContent = "The firewall still turns devices away (the permission prompt was refused or closed).";
    else status.textContent = "TVs and phones can reach this computer now. On the device, try again.";
  });

  uploads.addEventListener("change", () => {
    if (share.setUploads) run(() => share.setUploads!(uploads.checked));
  });
  root.querySelector("#share-incoming")?.addEventListener("click", () => void share.openIncoming?.());
  checkbox.addEventListener("change", () => {
    firewallChecked = false;
    run(() => share.setEnabled(checkbox.checked));
  });
  devices.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-forget]")?.dataset.forget;
    if (id) run(() => share.forgetDevice(id));
  });
  prompt.querySelector("#pair-refuse")!.addEventListener("click", () => run(() => share.cancelPairing()));
  prompt.addEventListener("cancel", (event) => {
    event.preventDefault();
    run(() => share.cancelPairing());
  });
  share.onChange(() => run(() => share.status()));
  run(() => share.status());
}
