use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("The reward must be greater than zero")]
    InvalidReward,
    #[msg("The deadline must be in the future")]
    InvalidDeadline,
    #[msg("This bounty is not open for submissions")]
    BountyNotOpen,
    #[msg("The creator cannot submit work to their own bounty")]
    CreatorCannotSubmit,
    #[msg("The bounty has no worker submission to approve")]
    SubmissionMissing,
    #[msg("The supplied worker is not the bounty's submitter")]
    WorkerMismatch,
    #[msg("The bounty escrow cannot cover this payout while preserving rent")]
    EscrowUnderfunded,
    #[msg("The lamport balance calculation overflowed")]
    ArithmeticOverflow,
    #[msg("The bounty deadline has not passed")]
    DeadlineNotReached,
    #[msg("The bounty deadline has passed")]
    BountyExpired,
}
