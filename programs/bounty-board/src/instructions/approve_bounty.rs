use anchor_lang::prelude::*;

use crate::{
    constants::BOUNTY_SEED,
    error::ErrorCode,
    instructions::pay_from_escrow,
    state::{Bounty, BountyStatus},
};

#[derive(Accounts)]
pub struct ApproveBounty<'info> {
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [BOUNTY_SEED, bounty.creator.as_ref(), &bounty.id.to_le_bytes()],
        bump,
        has_one = creator
    )]
    pub bounty: Account<'info, Bounty>,
    #[account(mut)]
    pub worker: SystemAccount<'info>,
}

pub fn handle_approve_bounty(ctx: Context<ApproveBounty>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;
    require!(bounty.status == BountyStatus::Submitted, ErrorCode::SubmissionMissing);
    require_keys_eq!(bounty.worker, ctx.accounts.worker.key(), ErrorCode::WorkerMismatch);

    pay_from_escrow(
        &bounty.to_account_info(),
        &ctx.accounts.worker.to_account_info(),
        bounty.reward_lamports,
    )?;
    bounty.status = BountyStatus::Paid;

    msg!("Bounty {} paid to worker", bounty.id);
    Ok(())
}
