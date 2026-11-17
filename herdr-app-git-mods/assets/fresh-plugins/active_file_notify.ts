/**
 * Notify Herdr IDE Explorer when a real file buffer is opened or activated in Fresh.
 * Zero timers and zero subprocesses: atomically replaces a tiny JSON state file.
 */
const editor = getEditor();
const daemon = editor.getEnv("FRESH_IDE_DAEMON") || "";
let lastPath = "";

function reportActiveFile(): void {
  try {
    const id = editor.getActiveBufferId();
    const info = editor.getBufferInfo(id);
    if (!info || !info.path || info.is_virtual || info.is_terminal) return;
    if (info.path === lastPath) return;
    lastPath = info.path;
    const payload = JSON.stringify({ daemon, file: info.path, ts: Date.now() });
    editor.replaceFile("/tmp/fresh-ide-active.json", payload);
    if (daemon) {
      editor.replaceFile(`/tmp/fresh-ide-active-${daemon}.json`, payload);
    }
  } catch {}
}

registerHandler("herdr_report_active_file", reportActiveFile);
editor.on("buffer_activated", "herdr_report_active_file");
editor.on("after_file_open", "herdr_report_active_file");
