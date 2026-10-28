pub mod approve_bounty;
pub mod create_bounty;
pub mod refund_bounty;
pub mod submit_work;

pub use approve_bounty::*;
pub use create_bounty::*;
pub use refund_bounty::*;
pub use submit_work::*;

use anchor_lang::prelude::*;

use crate::error::ErrorCode;

pub(crate) fn pay_from_escrow(
    escrow: &AccountInfo,
    recipient: &AccountInfo,
    amount: u64,
) -> Result<()> {
    let escrow_after = escrow
        .lamports()
        .checked_sub(amount)
        .ok_or(ErrorCode::EscrowUnderfunded)?;
    let rent_floor = Rent::get()?.minimum_balance(escrow.data_len());
    require!(escrow_after >= rent_floor, ErrorCode::EscrowUnderfunded);

    let recipient_after = recipient
        .lamports()
        .checked_add(amount)
        .ok_or(ErrorCode::ArithmeticOverflow)?;

    **escrow.try_borrow_mut_lamports()? = escrow_after;
    **recipient.try_borrow_mut_lamports()? = recipient_after;
    Ok(())
}
