function pluginPaneNotFound(error) {
  const detail = [error?.message, error?.stderr].filter(Boolean).join("\n");
  return /"code"\s*:\s*"plugin_pane_not_found"/.test(detail);
}

export async function closeVerifiedPluginPane({ run, herdr, paneId, cwd = "" }) {
  const options = {
    ...(cwd ? { cwd } : {}),
    timeoutMs: 5_000,
    maxOutputBytes: 256 * 1_024,
  };
  try {
    await run(herdr, ["plugin", "pane", "close", paneId], options);
    return { fallback: false };
  } catch (error) {
    if (!pluginPaneNotFound(error)) throw error;
    await run(herdr, ["pane", "close", paneId], options);
    return { fallback: true };
  }
}
