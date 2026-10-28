use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub id: u64,
    pub creator: Pubkey,
    pub worker: Pubkey,
    pub reward_lamports: u64,
    pub deadline: i64,
    pub submission_hash: [u8; 32],
    pub status: BountyStatus,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum BountyStatus {
    Open,
    Submitted,
    Paid,
    Refunded,
}
