// Settings > TV: share the library with the MediaVerse Studio TV app on the home network (D38, D39). Off until
// switched on here. A TV finds this computer by itself; pairing it once takes a one-time 6-digit code that this
// page shows (in a window over whatever page is open) when the TV asks. Paired TVs are listed and can be removed.

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
    <h3>Play on the TV</h3>
    <p>The MediaVerse Studio TV app can play this library on a TV in your home. While sharing is on, TVs you have
      paired can list and play your music, and see covers and lyrics. Nothing can be changed from the TV, and your
      folders are never shown. Devices outside your home network are always refused.</p>
    <label class="check"><input id="share-enabled" type="checkbox" /> <span>Share my library with the TV app</span></label>
    <div id="share-details" hidden>
      <p class="field-hint">On the TV, open MediaVerse Studio and choose this computer from the list. A 6-digit code
        then appears here; type it on the TV once. If the TV does not find this computer, choose "Type an address"
        on the TV and enter <strong id="share-address"></strong>.</p>
      <p><button id="share-arm" type="button">Pair a TV</button></p>
      <p id="share-armed" class="field-hint" hidden>Waiting for a TV. On the TV, open MediaVerse Studio and choose this computer. This wait lasts five minutes.</p>
      <p class="field-label">Paired TVs</p>
      <ul id="share-devices" class="share-devices"></ul>
      <div id="share-firewall" class="result-warning" hidden>
        <p>Windows Firewall is turning TVs away on this network, so they cannot find this computer.</p>
        <button id="share-firewall-allow" type="button">Let TVs reach this computer</button>
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
    <h2 id="pair-title">Pair a TV</h2>
    <p id="pair-who"></p>
    <p class="pair-code" id="pair-code"></p>
    <p class="field-hint">The code works once and for five minutes. If you did not just choose this computer on a TV,
      press Refuse.</p>
    <div class="dialog-actions"><button id="pair-refuse" class="secondary" type="button">Refuse</button></div>`;
  document.body.append(prompt);
  const who = prompt.querySelector<HTMLElement>("#pair-who")!;
  const pairCode = prompt.querySelector<HTMLElement>("#pair-code")!;

  function show(state: ShareStatus): void {
    checkbox.checked = state.enabled;
    details.hidden = !state.enabled;
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
      who.textContent = `${state.pairing.name} wants to play your library. Type this code on the TV:`;
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
    if (!open) status.textContent = "The firewall still turns TVs away (the permission prompt was refused or closed).";
    else status.textContent = "TVs can reach this computer now. On the TV, choose Search again.";
  });

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
