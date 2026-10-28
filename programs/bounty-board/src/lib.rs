pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DMqKGbqScoY1vUAf5ZHos4LDxFUmtbhai7zpAKUUKJX8");

#[program]
pub mod bounty_board {
    use super::*;

    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        id: u64,
        reward_lamports: u64,
        deadline: i64,
    ) -> Result<()> {
        crate::instructions::create_bounty::handle_create_bounty(
            ctx,
            id,
            reward_lamports,
            deadline,
        )
    }

    pub fn submit_work(ctx: Context<SubmitWork>, submission_hash: [u8; 32]) -> Result<()> {
        crate::instructions::submit_work::handle_submit_work(ctx, submission_hash)
    }

    pub fn approve_bounty(ctx: Context<ApproveBounty>) -> Result<()> {
        crate::instructions::approve_bounty::handle_approve_bounty(ctx)
    }

    pub fn refund_bounty(ctx: Context<RefundBounty>) -> Result<()> {
        crate::instructions::refund_bounty::handle_refund_bounty(ctx)
    }
}
