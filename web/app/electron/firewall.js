// Windows Firewall and TV sharing (owner, 2026-11-05): the TV could not find the PC although sharing was on,
// because Windows only allowed MediaVerse Studio on public networks while the home network is private. Settings > TV
// checks this and offers to add one narrow rule: inbound TCP on the sharing port, for this program, on private
// networks only. Adding it needs Windows' own administrator prompt; nothing is changed without it.

const { execFile } = require("node:child_process");

const RULE_NAME = "MediaVerse Studio (TV sharing)";

/** Runs a Windows PowerShell script and returns its standard output. */
function powershell(script, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: timeoutMs, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
}

/**
 * Whether the firewall turns TVs away, from what Windows says: the categories of the connected networks
 * ("Private", "Public", "DomainAuthenticated") and, for each enabled inbound rule that allows this program or the
 * port, its profiles ("Private", "Public, Private", "Any"). Blocked when a connected network's category is allowed
 * by none of them.
 */
function isBlocked(categories, allowedProfiles) {
  const profileOf = (category) => (/domain/i.test(category) ? "domain" : String(category).toLowerCase());
  const allowed = new Set();
  for (const entry of allowedProfiles) {
    for (const part of String(entry).split(",")) {
      const name = part.trim().toLowerCase();
      if (name === "any") ["private", "public", "domain"].forEach((p) => allowed.add(p));
      else if (name) allowed.add(name);
    }
  }
  const networks = categories.map(profileOf).filter(Boolean);
  return networks.length > 0 && networks.some((network) => !allowed.has(network));
}

/** Path and port go into a PowerShell single-quoted string: quotes doubled, nothing else is special there. */
const quoted = (text) => `'${String(text).replace(/'/g, "''")}'`;

async function check(program, port) {
  if (process.platform !== "win32") return { blocked: false, categories: [] };
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$categories = @(Get-NetConnectionProfile | ForEach-Object { [string]$_.NetworkCategory })",
    `$byProgram = @(Get-NetFirewallApplicationFilter -Program ${quoted(program)} | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | ForEach-Object { [string]$_.Profile })`,
    `$byPort = @(Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq '${Number(port)}' } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | ForEach-Object { [string]$_.Profile })`,
    "@{ categories = $categories; allowed = @($byProgram + $byPort) } | ConvertTo-Json -Compress",
  ].join("; ");
  const reply = JSON.parse((await powershell(script)).trim() || "{}");
  const categories = [].concat(reply.categories ?? []);
  return { blocked: isBlocked(categories, [].concat(reply.allowed ?? [])), categories };
}

/** Adds the rule through Windows' administrator prompt; resolves when the prompt is done (true if the rule exists). */
async function allow(program, port) {
  if (process.platform !== "win32") return false;
  const rule = `New-NetFirewallRule -DisplayName ${quoted(RULE_NAME)} -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort ${Number(port)} -Program ${quoted(program)}`;
  const elevated = `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',${quoted(rule)}`;
  try {
    await powershell(elevated, 120_000);
  } catch {
    // The person said no to the prompt, or it could not be shown.
  }
  return !(await check(program, port)).blocked;
}

// ---- Jellyfin on this computer (Settings > Jellyfin, D90): TVs reach it on TCP 8096 and find it on UDP 7359.
const JELLYFIN_RULE = "Jellyfin (added by MediaVerse Studio)";

/** Whether the firewall turns TVs away from a Jellyfin server on this computer (rules for jellyfin.exe or TCP 8096). */
async function checkJellyfin() {
  if (process.platform !== "win32") return { blocked: false, categories: [] };
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$categories = @(Get-NetConnectionProfile | ForEach-Object { [string]$_.NetworkCategory })",
    "$allow = { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }",
    "$program = (Get-Process jellyfin | Select-Object -First 1).Path",
    "$byProgram = @(); if ($program) { $byProgram = @(Get-NetFirewallApplicationFilter -Program $program | Get-NetFirewallRule | Where-Object $allow | ForEach-Object { [string]$_.Profile }) }",
    "$byPort = @(Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq '8096' } | Get-NetFirewallRule | Where-Object $allow | ForEach-Object { [string]$_.Profile })",
    "@{ categories = $categories; allowed = @($byProgram + $byPort) } | ConvertTo-Json -Compress",
  ].join("; ");
  const reply = JSON.parse((await powershell(script)).trim() || "{}");
  const categories = [].concat(reply.categories ?? []);
  return { blocked: isBlocked(categories, [].concat(reply.allowed ?? [])), categories };
}

/** Adds two narrow rules (TCP 8096, UDP 7359; private networks only) through Windows' administrator prompt. */
async function allowJellyfin() {
  if (process.platform !== "win32") return false;
  const rules = [
    `New-NetFirewallRule -DisplayName ${quoted(`${JELLYFIN_RULE} - web`)} -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort 8096`,
    `New-NetFirewallRule -DisplayName ${quoted(`${JELLYFIN_RULE} - discovery`)} -Direction Inbound -Action Allow -Profile Private -Protocol UDP -LocalPort 7359`,
  ].join("; ");
  const elevated = `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',${quoted(rules)}`;
  try {
    await powershell(elevated, 120_000);
  } catch {
    // The person said no to the prompt, or it could not be shown.
  }
  return !(await checkJellyfin()).blocked;
}

module.exports = { check, allow, isBlocked, RULE_NAME, checkJellyfin, allowJellyfin, JELLYFIN_RULE };
