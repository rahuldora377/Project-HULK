/**
 * google/logger.js
 * ---------------------------------------------------------------------------
 * Minimal leveled logging system (debug/info/warn/error) with timestamps and
 * a global enabled/min-level switch. Works in service workers, extension
 * pages and Node. Exposes global `HulkLog` (or CommonJS export).
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HulkLog = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  let enabled = true;
  let minLevel = "info";

  /** Turn all logging on/off. */
  function setEnabled(v) {
    enabled = !!v;
  }

  /** Set the minimum level: "debug" | "info" | "warn" | "error". */
  function setLevel(level) {
    if (LEVELS[level] !== undefined) minLevel = level;
  }

  /**
   * Route a log call. Error/warn always print; debug prints only when
   * minLevel is "debug".
   */
  function emit(level, args) {
    if (!enabled) return;
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const fn = level === "debug" ? console.log : console[level];
    const style =
      level === "error" ? "color:#f87171;font-weight:700" :
      level === "warn" ? "color:#fbbf24" :
      level === "debug" ? "color:#94a3b8" : "color:#818cf8";
    try {
      fn(`%c[HULK ${ts}] ${level.toUpperCase()}`, style, ...args);
    } catch (err) {
      fn("[HULK]", ...args);
    }
  }

  return {
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
    setEnabled,
    setLevel
  };
});
