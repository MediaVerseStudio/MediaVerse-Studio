// The mini player's page: shows what the main window says is playing and sends commands back. Everything is set with textContent or a style property.
const $ = (id) => document.getElementById(id);
let duration = 0;

window.miniPlayer.onState((state) => {
  $("title").textContent = state.hasTrack ? state.title || "Unknown song" : "Nothing playing";
  $("artist").textContent = state.hasTrack ? state.artist : "";
  $("cover").style.backgroundImage = state.cover ? `url("${state.cover}")` : "none";
  $("toggle").classList.toggle("is-playing", !!state.playing);
  $("toggle").setAttribute("aria-label", state.playing ? "Pause" : "Play");
  $("toggle").title = state.playing ? "Pause" : "Play";
  $("previous").disabled = !(state.hasTrack && state.canPrevious);
  $("next").disabled = !(state.hasTrack && state.canNext);
  $("toggle").disabled = !state.hasTrack;
  duration = state.duration;
  $("fill").style.width = duration ? `${Math.min(100, (state.position / duration) * 100)}%` : "0";
  if (document.activeElement !== $("volume")) $("volume").value = String(state.muted ? 0 : state.volume);
  $("pin").setAttribute("aria-pressed", String(state.pinned !== false));
  $("pin").title = state.pinned === false ? "Stay on top: off (click to turn on)" : "Stay on top: on (click to turn off)";
  if (state.accent)document.documentElement.style.setProperty("--accent", state.accent);
});

$("toggle").addEventListener("click", () => window.miniPlayer.command({ action: "toggle" }));
$("previous").addEventListener("click", () => window.miniPlayer.command({ action: "previous" }));
$("next").addEventListener("click", () => window.miniPlayer.command({ action: "next" }));
$("volume").addEventListener("input", () => window.miniPlayer.command({ action: "volume", value: Number($("volume").value) }));
$("bar").addEventListener("click", (event) => {
  if (!duration) return;
  const box = $("bar").getBoundingClientRect();
  window.miniPlayer.command({ action: "seek", value: ((event.clientX - box.left) / box.width) * duration });
});
$("pin").addEventListener("click", () => window.miniPlayer.pin());
$("main").addEventListener("click", () => window.miniPlayer.showMain());
window.addEventListener("wheel", (event) => {
  const next = Math.min(1, Math.max(0, Number($("volume").value) + (event.deltaY < 0 ? 0.04 : -0.04)));
  $("volume").value = String(next);
  window.miniPlayer.command({ action: "volume", value: next });
});
