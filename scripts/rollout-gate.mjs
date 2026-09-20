// The operator supplies concrete, bounded operations. Never resume on an unverified rollback.
export async function performRollout(operations) {
  let activationStarted = false, fenceConfirmed = false, status;
  try {
    await operations.fence();
    fenceConfirmed = true;
    await operations.drain();
    activationStarted = true;
    await operations.activate();
    await operations.verifyCandidate();
    status = 'candidate_active_verified';
  } catch (error) {
    if (error?.operation_state_unknown) return { status: 'operation_state_unknown', phase: error.phase,
      public_resumed: fenceConfirmed ? false : null, operator_check_required: true };
    try {
      if (activationStarted) await operations.rollback();
      await operations.verifyPrevious();
      status = activationStarted ? 'previous_restored_verified' : 'aborted_previous_verified';
    } catch (error) {
      if (error?.operation_state_unknown) return { status: 'operation_state_unknown', phase: error.phase,
        public_resumed: fenceConfirmed ? false : null, operator_check_required: true };
      // No finally resume. The service-specific maintenance fence must survive failure.
      return { status: fenceConfirmed ? 'maintenance_required' : 'public_state_unknown', public_resumed: fenceConfirmed ? false : null };
    }
  }
  // A failed acknowledgement can follow a successful external resume effect.
  // Never replace a process or claim maintenance after that ambiguous boundary.
  try {
    await operations.resume();
    return { status, public_resumed: true };
  } catch {
    return { status: 'public_state_unknown', public_resumed: null, verified_release: status, operator_check_required: true };
  }
}
