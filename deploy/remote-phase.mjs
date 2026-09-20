// An SSH failure does not prove the remote operation stopped. Only the helper's
// completed failure record permits ordinary gate recovery.
export async function runRemotePhase(name, invoke) {
  const uncertain = () => Object.assign(Error('Remote operation completion unconfirmed'), { operation_state_unknown: true, phase: name });
  const parse = stdout => {
    try {
      const event = JSON.parse(String(stdout).trim());
      if (event.phase === name && ['pass', 'failed'].includes(event.status) && Number.isFinite(Date.parse(event.finished_at))) return event;
    } catch { /* No trustworthy completion record. */ }
  };
  let result;
  try { result = await invoke(); }
  catch (error) {
    const event = parse(error.stdout);
    if (error.code === 1 && event?.status === 'failed' && !event.operation_state_unknown) throw Error('Remote phase completed with failure');
    throw uncertain();
  }
  const event = parse(result.stdout);
  if (!event || event.status !== 'pass' || event.operation_state_unknown) throw uncertain();
  return event;
}
