"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import idl from "../idl/bounty_board.json";
import type { BountyBoard } from "../idl/bounty_board";

type BountyRow = {
  address: string;
  id: string;
  title: string;
  description: string;
  creator: string;
  worker: string | null;
  reward: number;
  deadline: Date;
  status: string;
  submission: SubmissionMetadata | null;
};

type BountyMetadata = {
  bounty_address: string;
  title: string;
  description: string;
};

type SubmissionMetadata = {
  worker_address: string;
  proof_url: string;
  submission_hash: string;
  created_at: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

function shortAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, signMessage } = useWallet();
  const anchorWallet = useAnchorWallet();
  const [mounted, setMounted] = useState(false);
  const [bounties, setBounties] = useState<BountyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [rewardSol, setRewardSol] = useState("0.1");
  const [deadlineInput, setDeadlineInput] = useState("");
  const [submissionBounty, setSubmissionBounty] = useState<BountyRow | null>(null);
  const [proofUrl, setProofUrl] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  async function signedApiHeaders(path: string, body: string) {
    if (!publicKey || !signMessage) {
      throw new Error("Your connected wallet must support signing messages to save this data.");
    }
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const bodyHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const message = [
      "Bounty Board API request",
      "method: POST",
      `path: ${path}`,
      `wallet: ${publicKey.toBase58()}`,
      `timestamp: ${timestamp}`,
      `nonce: ${nonce}`,
      `body-sha256: ${bodyHash}`,
    ].join("\n");
    const signature = await signMessage(new TextEncoder().encode(message));
    return {
      "Content-Type": "application/json",
      "x-wallet-address": publicKey.toBase58(),
      "x-wallet-timestamp": timestamp,
      "x-wallet-nonce": nonce,
      "x-wallet-signature": btoa(Array.from(signature, (byte) => String.fromCharCode(byte)).join("")),
    };
  }

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const program = new Program<BountyBoard>(idl as BountyBoard, { connection });
    Promise.all([
      program.account.bounty.all(),
      fetch(`${API_BASE}/api/bounties`, { cache: "no-store" })
        .then(async (response) => response.ok ? await response.json() as BountyMetadata[] : [])
        .catch(() => [] as BountyMetadata[]),
    ])
      .then(async ([rows, metadata]) => {
        if (!active) return;
        const metadataByAddress = new Map(metadata.map((item) => [item.bounty_address, item]));
        const submissions = await Promise.all(rows.map(async ({ publicKey }) => {
          const address = publicKey.toBase58();
          try {
            const response = await fetch(`${API_BASE}/api/bounties/${address}`, { cache: "no-store" });
            if (!response.ok) return [address, null] as const;
            const detail = await response.json() as { submissions: SubmissionMetadata[] };
            return [address, detail.submissions[0] ?? null] as const;
          } catch {
            return [address, null] as const;
          }
        }));
        const submissionByAddress = new Map(submissions);
        if (!active) return;
        setBounties(
          rows.map(({ publicKey, account }) => ({
            address: publicKey.toBase58(),
            id: account.id.toString(),
            title: metadataByAddress.get(publicKey.toBase58())?.title ?? `Bounty #${account.id.toString()}`,
            description: metadataByAddress.get(publicKey.toBase58())?.description ?? "Details are not available yet.",
            creator: account.creator.toBase58(),
            worker: account.worker.equals(PublicKey.default)
              ? null
              : account.worker.toBase58(),
            reward: Number(account.rewardLamports.toString()) / 1_000_000_000,
            deadline: new Date(Number(account.deadline.toString()) * 1000),
            status: Object.keys(account.status as object)[0] ?? "unknown",
            submission: submissionByAddress.get(publicKey.toBase58()) ?? null,
          })),
        );
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not load bounties.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [connection, refreshKey]);

  async function createBounty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);

    if (!publicKey || !anchorWallet) {
      setNotice({ kind: "error", message: "Connect your wallet before posting a bounty." });
      return;
    }

    const reward = Number(rewardSol);
    const deadlineSeconds = Math.floor(new Date(deadlineInput).getTime() / 1000);
    if (!Number.isFinite(reward) || reward <= 0) {
      setNotice({ kind: "error", message: "Enter a reward greater than zero." });
      return;
    }
    if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= Math.floor(Date.now() / 1000)) {
      setNotice({ kind: "error", message: "Choose a deadline in the future." });
      return;
    }

    setCreating(true);
    let fundingSignature: string | null = null;
    try {
      const programInfo = new Program<BountyBoard>(idl as BountyBoard, { connection });
      const deployedProgram = await connection.getAccountInfo(programInfo.programId);
      if (!deployedProgram) {
        throw new Error("The Bounty Board program is not deployed to Devnet yet.");
      }

      const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
      const program = new Program<BountyBoard>(idl as BountyBoard, provider);
      const id = new BN(Date.now().toString());
      const rewardLamports = new BN(Math.round(reward * 1_000_000_000).toString());
      const [bountyAddress] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("bounty"), publicKey.toBytes(), id.toArrayLike(Uint8Array, "le", 8)],
        program.programId,
      );
      const metadataBody = JSON.stringify({
        bounty_address: bountyAddress.toBase58(),
        creator_address: publicKey.toBase58(),
        title: title.trim(),
        description: description.trim(),
      });
      const metadataHeaders = await signedApiHeaders("/api/bounties", metadataBody);

      const signature = await program.methods
        .createBounty(id, rewardLamports, new BN(deadlineSeconds))
        .accounts({
          creator: publicKey,
        })
        .rpc();
      fundingSignature = signature;

      const metadataResponse = await fetch(`${API_BASE}/api/bounties`, {
        method: "POST",
        headers: metadataHeaders,
        body: metadataBody,
      });

      setShowCreate(false);
      setTitle("");
      setDescription("");
      setDeadlineInput("");
      setRefreshKey((value) => value + 1);
      if (!metadataResponse.ok) {
        setNotice({
          kind: "error",
          message: `Bounty funded on-chain, but saving its description failed. Transaction: ${signature.slice(0, 10)}…`,
        });
      } else {
        setNotice({ kind: "success", message: "Bounty posted and funded on Devnet." });
      }
    } catch (cause) {
      setNotice({
        kind: "error",
        message: fundingSignature
          ? `Bounty is funded on-chain, but its description was not saved. Transaction: ${fundingSignature.slice(0, 10)}… ${cause instanceof Error ? cause.message : "Sign the API request and try again."}`
          : cause instanceof Error ? cause.message : "Could not create the bounty.",
      });
    } finally {
      setCreating(false);
    }
  }

  async function submitWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submissionBounty || !publicKey || !anchorWallet) {
      setNotice({ kind: "error", message: "Connect a wallet before submitting work." });
      return;
    }

    const link = proofUrl.trim();
    if (!link.startsWith("https://") && !link.startsWith("ipfs://")) {
      setNotice({ kind: "error", message: "Use an https:// or ipfs:// link for your proof." });
      return;
    }

    setActionBusy(submissionBounty.address);
    setNotice(null);
    let workSignature: string | null = null;
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(link));
      const submissionHash = Array.from(new Uint8Array(digest));
      const submissionPath = `/api/bounties/${submissionBounty.address}/submissions`;
      const submissionBody = JSON.stringify({
        worker_address: publicKey.toBase58(),
        proof_url: link,
        submission_hash: submissionHash.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      });
      const submissionHeaders = await signedApiHeaders(submissionPath, submissionBody);
      const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
      const program = new Program<BountyBoard>(idl as BountyBoard, provider);
      const bountyAddress = new PublicKey(submissionBounty.address);
      const signature = await program.methods
        .submitWork(submissionHash)
        .accountsPartial({ worker: publicKey, bounty: bountyAddress })
        .rpc();
      workSignature = signature;

      const metadataResponse = await fetch(`${API_BASE}${submissionPath}`, {
        method: "POST",
        headers: submissionHeaders,
        body: submissionBody,
      });

      setSubmissionBounty(null);
      setProofUrl("");
      setRefreshKey((value) => value + 1);
      setNotice(metadataResponse.ok
        ? { kind: "success", message: "Work submitted. The creator can now review it." }
        : { kind: "error", message: `Work is on-chain, but the proof link could not be saved. Transaction: ${signature.slice(0, 10)}…` });
    } catch (cause) {
      setNotice({
        kind: "error",
        message: workSignature
          ? `Work was recorded on-chain, but its proof link was not saved. Transaction: ${workSignature.slice(0, 10)}… ${cause instanceof Error ? cause.message : "Sign the API request and try again."}`
          : cause instanceof Error ? cause.message : "Could not submit work.",
      });
    } finally {
      setActionBusy(null);
    }
  }

  async function approveBounty(bounty: BountyRow) {
    if (!publicKey || !anchorWallet || !bounty.worker) return;
    setActionBusy(bounty.address);
    setNotice(null);
    try {
      const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
      const program = new Program<BountyBoard>(idl as BountyBoard, provider);
      await program.methods
        .approveBounty()
        .accountsPartial({
          creator: publicKey,
          bounty: new PublicKey(bounty.address),
          worker: new PublicKey(bounty.worker),
        })
        .rpc();
      setRefreshKey((value) => value + 1);
      setNotice({ kind: "success", message: "Submission approved and reward paid to the worker." });
    } catch (cause) {
      setNotice({ kind: "error", message: cause instanceof Error ? cause.message : "Could not approve the bounty." });
    } finally {
      setActionBusy(null);
    }
  }

  async function refundBounty(bounty: BountyRow) {
    if (!publicKey || !anchorWallet) return;
    setActionBusy(bounty.address);
    setNotice(null);
    try {
      const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
      const program = new Program<BountyBoard>(idl as BountyBoard, provider);
      await program.methods
        .refundBounty()
        .accountsPartial({ creator: publicKey, bounty: new PublicKey(bounty.address) })
        .rpc();
      setRefreshKey((value) => value + 1);
      setNotice({ kind: "success", message: "Expired bounty refunded to the creator." });
    } catch (cause) {
      setNotice({ kind: "error", message: cause instanceof Error ? cause.message : "Could not refund the bounty." });
    } finally {
      setActionBusy(null);
    }
  }

  const openCount = bounties.filter((bounty) => bounty.status === "open").length;

  return (
    <main className="min-h-screen px-5 py-6 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-[#e7e8e2] pb-6">
          <a className="flex items-center gap-3" href="#top" aria-label="Bounty Board home">
            <span className="brand-mark">B</span>
            <span>
              <span className="block text-sm font-bold tracking-[0.12em] text-[#183d33]">BOUNTY BOARD</span>
              <span className="block text-xs text-[#79857d]">Solana community work</span>
            </span>
          </a>
          <div className="flex items-center gap-3">
            <span className="network-pill"><span className="network-dot" /> Devnet</span>
            {mounted ? (
              <WalletMultiButton className="wallet-connect" />
            ) : (
              <button className="wallet-adapter-button wallet-connect" disabled type="button">
                Connect wallet
              </button>
            )}
          </div>
        </header>

        <section id="top" className="hero-grid py-12 sm:py-16">
          <div className="max-w-3xl">
            <p className="eyebrow">GOOD WORK, FAIR REWARDS</p>
            <h1 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-[-0.045em] text-[#17392f] sm:text-6xl">
              Small tasks.<br />
              <span className="text-[#4d8068]">Real on-chain rewards.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-[#68756d] sm:text-lg">
              A simple place to fund useful work, submit a result, and release payment on Solana.
            </p>
          </div>
          <div className="hero-note">
            <span className="note-icon">↗</span>
            <p className="text-sm font-semibold text-[#244b3d]">Escrowed by the program</p>
            <p className="mt-2 text-sm leading-6 text-[#728077]">
              Rewards stay in the bounty account until approval or an eligible refund.
            </p>
          </div>
        </section>

        <section className="mb-5 grid gap-4 sm:grid-cols-3" aria-label="Bounty board summary">
          <div className="summary-card">
            <span className="summary-label">OPEN BOUNTIES</span>
            <strong>{loading ? "—" : openCount}</strong>
            <span className="summary-caption">Available to work on</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">TOTAL LISTED</span>
            <strong>{loading ? "—" : bounties.length}</strong>
            <span className="summary-caption">Read directly from Solana</span>
          </div>
          <div className="summary-card summary-program">
            <span className="summary-label">PROGRAM</span>
            <strong className="!text-base sm:!text-lg">DMqK…KJX8</strong>
            <span className="summary-caption">Bounty Board · Devnet</span>
          </div>
        </section>

        <section className="board-panel">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#e9ebe5] px-5 py-5 sm:px-7">
            <div>
              <p className="eyebrow">THE BOARD</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-[#193c32]">Browse bounties</h2>
            </div>
            <button className="refresh-button" onClick={refresh} type="button" disabled={loading}>
              <span aria-hidden="true">↻</span> Refresh
            </button>
            <button className="post-button" onClick={() => { setNotice(null); setShowCreate(true); }} type="button">
              + Post a bounty
            </button>
          </div>

          {notice && (
            <div className={`notice notice-${notice.kind}`} role="status">
              <span>{notice.message}</span>
              <button onClick={() => setNotice(null)} type="button" aria-label="Dismiss message">×</button>
            </div>
          )}

          {error ? (
            <div className="empty-state">
              <span className="empty-icon">!</span>
              <h3>Couldn’t load the bounty board</h3>
              <p>{error}</p>
              <button className="refresh-button mt-4" onClick={refresh} type="button">Try again</button>
            </div>
          ) : loading ? (
            <div className="empty-state">
              <span className="loading-orbit" />
              <p>Reading bounties from Devnet…</p>
            </div>
          ) : bounties.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">✳</span>
              <h3>The board is ready for its first bounty</h3>
              <p>Connect your wallet to Devnet and post the first funded task.</p>
            </div>
          ) : (
            <div className="divide-y divide-[#edf0ea]">
              {bounties.map((bounty) => (
                <article className="bounty-row" key={bounty.address}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="font-semibold text-[#1b3b31]">{bounty.title}</h3>
                      <span className={`status-pill status-${bounty.status}`}>{bounty.status}</span>
                    </div>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-[#77827b]">{bounty.description}</p>
                    <p className="mt-2 text-xs text-[#929b94]">Posted by {shortAddress(bounty.creator)} · Bounty #{bounty.id}</p>
                    <p className="mt-1 text-xs text-[#929b94]">Due {bounty.deadline.toLocaleString()}</p>
                    {bounty.status === "submitted" && (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <span className="text-xs text-[#77827b]">Submitted by {bounty.worker ? shortAddress(bounty.worker) : "a worker"}</span>
                        {bounty.submission && (
                          <a className="proof-link" href={bounty.submission.proof_url} target="_blank" rel="noreferrer">
                            View proof ↗
                          </a>
                        )}
                        {publicKey?.toBase58() === bounty.creator && (
                          <button className="row-action" disabled={actionBusy === bounty.address} onClick={() => approveBounty(bounty)} type="button">
                            {actionBusy === bounty.address ? "Processing…" : "Approve & pay"}
                          </button>
                        )}
                      </div>
                    )}
                    {bounty.status === "open" && publicKey?.toBase58() !== bounty.creator && (
                      <div className="mt-3">
                        <button className="row-action" disabled={actionBusy === bounty.address} onClick={() => { setNotice(null); setSubmissionBounty(bounty); }} type="button">
                          Submit work
                        </button>
                      </div>
                    )}
                    {bounty.status === "open" && publicKey?.toBase58() === bounty.creator && Date.now() >= bounty.deadline.getTime() && (
                      <div className="mt-3">
                        <button className="row-action row-action-muted" disabled={actionBusy === bounty.address} onClick={() => refundBounty(bounty)} type="button">
                          {actionBusy === bounty.address ? "Processing…" : "Refund expired bounty"}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <strong className="block text-xl font-semibold text-[#244b3d]">{bounty.reward.toFixed(3)} SOL</strong>
                    <span className="mt-1 block text-xs text-[#8a968e]">
                      {bounty.status === "paid" ? "Paid on Devnet" : bounty.status === "refunded" ? "Refunded on Devnet" : "Escrowed on Devnet"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <footer className="flex flex-wrap justify-between gap-3 py-7 text-xs text-[#8b958e]">
          <span>Built for open collaboration.</span>
          <span>Solana Devnet · Wallet signatures are required for on-chain actions.</span>
        </footer>

        {showCreate && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !creating) setShowCreate(false);
          }}>
            <section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="eyebrow">FUND A TASK</p>
                  <h2 id="create-title" className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-[#193c32]">Post a bounty</h2>
                </div>
                <button className="close-button" disabled={creating} onClick={() => setShowCreate(false)} type="button" aria-label="Close">×</button>
              </div>
              <p className="mt-2 text-sm leading-6 text-[#77827b]">Your reward is held in the program escrow. The title and description are saved by the Rust API.</p>

              <form className="mt-6 space-y-4" onSubmit={createBounty}>
                <label className="form-field">
                  <span>Title</span>
                  <input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to be done?" />
                </label>
                <label className="form-field">
                  <span>Description</span>
                  <textarea required maxLength={2000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the work and what counts as completion." />
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="form-field">
                    <span>Reward (SOL)</span>
                    <input required min="0.000000001" step="0.000000001" type="number" value={rewardSol} onChange={(event) => setRewardSol(event.target.value)} />
                  </label>
                  <label className="form-field">
                    <span>Deadline</span>
                    <input required type="datetime-local" value={deadlineInput} onChange={(event) => setDeadlineInput(event.target.value)} />
                  </label>
                </div>
                <div className="modal-actions">
                  <button className="cancel-button" disabled={creating} onClick={() => setShowCreate(false)} type="button">Cancel</button>
                  <button className="post-button" disabled={creating || !publicKey} type="submit">
                    {creating ? "Waiting for wallet…" : "Fund bounty"}
                  </button>
                </div>
                {!publicKey && <p className="text-xs text-[#9a7340]">Connect your wallet to fund a bounty on Devnet.</p>}
              </form>
            </section>
          </div>
        )}

        {submissionBounty && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !actionBusy) setSubmissionBounty(null);
          }}>
            <section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="submit-title">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="eyebrow">SHOW YOUR WORK</p>
                  <h2 id="submit-title" className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-[#193c32]">Submit for {submissionBounty.title}</h2>
                </div>
                <button className="close-button" disabled={!!actionBusy} onClick={() => setSubmissionBounty(null)} type="button" aria-label="Close">×</button>
              </div>
              <p className="mt-2 text-sm leading-6 text-[#77827b]">Paste a public link to your completed work. A SHA-256 hash of the link is recorded on-chain.</p>

              <form className="mt-6 space-y-4" onSubmit={submitWork}>
                <label className="form-field">
                  <span>Proof link</span>
                  <input required type="url" value={proofUrl} onChange={(event) => setProofUrl(event.target.value)} placeholder="https://… or ipfs://…" />
                </label>
                <div className="modal-actions">
                  <button className="cancel-button" disabled={!!actionBusy} onClick={() => setSubmissionBounty(null)} type="button">Cancel</button>
                  <button className="post-button" disabled={!!actionBusy || !publicKey} type="submit">
                    {actionBusy === submissionBounty.address ? "Waiting for wallet…" : "Submit work"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
