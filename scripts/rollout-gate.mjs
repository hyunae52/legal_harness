// The operator supplies concrete, bounded operations. Never resume on an unverified rollback.
export async function performRollout(operations) {
  let activationStarted = false;
  try {
    await operations.fence();
    await operations.drain();
    activationStarted = true;
    await operations.activate();
    await operations.verifyCandidate();
    await operations.resume();
    return { status: 'candidate_active_verified', public_resumed: true };
  } catch {
    try {
      if (activationStarted) await operations.rollback();
      await operations.verifyPrevious();
      await operations.resume();
      return { status: activationStarted ? 'previous_restored_verified' : 'aborted_previous_verified', public_resumed: true };
    } catch {
      // No finally resume. The service-specific maintenance fence must survive failure.
      return { status: 'maintenance_required', public_resumed: false };
    }
  }
}
