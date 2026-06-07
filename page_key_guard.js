(() => {
  const HOST_ID = "es-copilot-topic-fixed-shadow-host";
  const BOOT_FLAG = "__esCopilotPageKeyGuardBooted";
  const MESSAGE_SOURCE = "ES_COPILOT_PAGE_KEY_GUARD";

  if (window[BOOT_FLAG]) return;
  window[BOOT_FLAG] = true;

  function isPlainStickyC(event) {
    return (
      ["keydown", "keypress", "keyup"].includes(event.type) &&
      String(event.key || "").toLowerCase() === "c" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    );
  }

  function isFromCopilotHost(event) {
    const target = event.target;
    if (target?.id === HOST_ID) return true;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.some((node) => node?.id === HOST_ID);
  }

  function blockStripChatStickyC(event) {
    if (!isPlainStickyC(event) || !isFromCopilotHost(event)) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    if (event.type === "keydown") {
      window.postMessage(
        {
          source: MESSAGE_SOURCE,
          type: "INSERT_KEY",
          key: event.key || "c"
        },
        location.origin || "*"
      );
    }
  }

  ["keydown", "keypress", "keyup"].forEach((eventName) => {
    window.addEventListener(eventName, blockStripChatStickyC, true);
    document.addEventListener(eventName, blockStripChatStickyC, true);
  });
})();
