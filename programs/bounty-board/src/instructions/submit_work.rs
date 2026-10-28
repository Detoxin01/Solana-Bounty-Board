use anchor_lang::prelude::*;

use crate::{constants::BOUNTY_SEED, error::ErrorCode, state::{Bounty, BountyStatus}};

#[derive(Accounts)]
pub struct SubmitWork<'info> {
    pub worker: Signer<'info>,
    #[account(
        mut,
        seeds = [BOUNTY_SEED, bounty.creator.as_ref(), &bounty.id.to_le_bytes()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,
}

pub fn handle_submit_work(
    ctx: Context<SubmitWork>,
    submission_hash: [u8; 32],
) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;
    require!(bounty.status == BountyStatus::Open, ErrorCode::BountyNotOpen);
    require!(bounty.creator != ctx.accounts.worker.key(), ErrorCode::CreatorCannotSubmit);
    require!(Clock::get()?.unix_timestamp < bounty.deadline, ErrorCode::BountyExpired);

    bounty.worker = ctx.accounts.worker.key();
    bounty.submission_hash = submission_hash;
    bounty.status = BountyStatus::Submitted;

    msg!("Work submitted for bounty {}", bounty.id);
    Ok(())
}
