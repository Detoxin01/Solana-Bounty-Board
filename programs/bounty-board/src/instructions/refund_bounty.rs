use anchor_lang::prelude::*;

use crate::{
    constants::BOUNTY_SEED,
    error::ErrorCode,
    instructions::pay_from_escrow,
    state::{Bounty, BountyStatus},
};

#[derive(Accounts)]
pub struct RefundBounty<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [BOUNTY_SEED, creator.key().as_ref(), &bounty.id.to_le_bytes()],
        bump,
        has_one = creator
    )]
    pub bounty: Account<'info, Bounty>,
}

pub fn handle_refund_bounty(ctx: Context<RefundBounty>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;
    require!(bounty.status == BountyStatus::Open, ErrorCode::BountyNotOpen);
    require!(Clock::get()?.unix_timestamp >= bounty.deadline, ErrorCode::DeadlineNotReached);

    pay_from_escrow(
        &bounty.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        bounty.reward_lamports,
    )?;
    bounty.status = BountyStatus::Refunded;

    msg!("Bounty {} refunded to creator", bounty.id);
    Ok(())
}
