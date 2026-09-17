/** Own a rail's subscription/view lifetime without coupling redraws to Git. */
export function createRailStateClient({
  client, onSnapshot = () => {}, onStatus = () => {}, onRender = () => {}, onContext = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, ageIntervalMs = 60_000,
}) {
  let closed = false;
  let handle;
  let context;
  let visible = true;
  let latest;
  let lastStateGeneration;
  let lastStatus;
  let ageTimer;
  let revision = 0;
  const closing = new Set();

  function render() { if (!closed && visible) onRender(); }
  function updateAgeTimer() {
    clearTimer(ageTimer); ageTimer = undefined;
    if (closed || !visible || !handle) return;
    ageTimer = setTimer(() => { ageTimer = undefined; render(); updateAgeTimer(); }, ageIntervalMs);
    ageTimer.unref?.();
  }
  function release() {
    const previous = handle; handle = undefined;
    if (!previous) return;
    const pending = Promise.resolve(previous.close()).catch(() => {}).finally(() => closing.delete(pending));
    closing.add(pending);
  }
  async function updateContext(next) {
    if (closed) return null;
    const previousVisible = visible;
    visible = next?.visible !== false;
    const hasContent = Boolean(next?.cwd) && next?.hasContent !== false;
    const key = hasContent ? next.engineKey || next.cwd : null;
    const previousKey = context && context.hasContent !== false ? context.engineKey || context.cwd : null;
    context = next;
    onContext(next);
    if (key === previousKey && (handle || key === null)) {
      if (visible !== previousVisible) { updateAgeTimer(); render(); }
      return latest;
    }
    const currentRevision = ++revision;
    release(); latest = undefined; lastStateGeneration = undefined; lastStatus = undefined;
    if (!hasContent) {
      onStatus({ status: "suspended", error: { message: "No content pane in this tab" } });
      updateAgeTimer(); render(); return null;
    }
    const receive = (delivery) => {
      if (closed || currentRevision !== revision) return;
      const changed = lastStateGeneration !== delivery.stateGeneration;
      const statusChanged = lastStatus !== delivery.status;
      latest = delivery;
      if (delivery.snapshot && changed) {
        lastStateGeneration = delivery.stateGeneration;
        onSnapshot(delivery.snapshot, delivery);
      }
      if (statusChanged) { lastStatus = delivery.status; onStatus(delivery); }
      if (changed || statusChanged) render();
    };
    handle = client.subscribe(next, receive);
    updateAgeTimer();
    try {
      const first = await handle.ready;
      if (currentRevision === revision && !closed && first) receive(first);
      return currentRevision === revision && !closed ? latest : null;
    } catch (error) {
      if (currentRevision === revision && !closed) {
        onStatus({ status: "error", error: { message: String(error.message || error) } }); render();
      }
      return null;
    }
  }
  return {
    updateContext,
    get visible() { return visible; },
    get contextGeneration() { return revision; },
    latest: () => latest,
    async refresh(reason = "manual") { return handle ? handle.refresh(reason) : null; },
    async close() {
      if (closed) return;
      closed = true; revision += 1; clearTimer(ageTimer); release();
      await Promise.allSettled([...closing]); await client.close();
    },
  };
}
