use anchor_lang::prelude::*;

use crate::{constants::BOUNTY_SEED, error::ErrorCode, state::{Bounty, BountyStatus}};

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateBounty<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [BOUNTY_SEED, creator.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_bounty(
    ctx: Context<CreateBounty>,
    id: u64,
    reward_lamports: u64,
    deadline: i64,
) -> Result<()> {
    require!(reward_lamports > 0, ErrorCode::InvalidReward);
    require!(deadline > Clock::get()?.unix_timestamp, ErrorCode::InvalidDeadline);

    let transfer_accounts = anchor_lang::system_program::Transfer {
        from: ctx.accounts.creator.to_account_info(),
        to: ctx.accounts.bounty.to_account_info(),
    };
    anchor_lang::system_program::transfer(
        CpiContext::new(ctx.accounts.system_program.key(), transfer_accounts),
        reward_lamports,
    )?;

    let bounty = &mut ctx.accounts.bounty;
    bounty.id = id;
    bounty.creator = ctx.accounts.creator.key();
    bounty.worker = Pubkey::default();
    bounty.reward_lamports = reward_lamports;
    bounty.deadline = deadline;
    bounty.submission_hash = [0; 32];
    bounty.status = BountyStatus::Open;

    msg!("Bounty {} created with {} lamports", id, reward_lamports);
    Ok(())
}
