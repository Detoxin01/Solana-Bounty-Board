/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bounty_board.json`.
 */
export type BountyBoard = {
  "address": "DMqKGbqScoY1vUAf5ZHos4LDxFUmtbhai7zpAKUUKJX8",
  "metadata": {
    "name": "bountyBoard",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "approveBounty",
      "discriminator": [
        159,
        69,
        100,
        84,
        88,
        57,
        93,
        29
      ],
      "accounts": [
        {
          "name": "creator",
          "signer": true,
          "relations": [
            "bounty"
          ]
        },
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "bounty.creator",
                "account": "bounty"
              },
              {
                "kind": "account",
                "path": "bounty.id",
                "account": "bounty"
              }
            ]
          }
        },
        {
          "name": "worker",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createBounty",
      "discriminator": [
        122,
        90,
        14,
        143,
        8,
        125,
        200,
        2
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "rewardLamports",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "i64"
        }
      ]
    },
    {
      "name": "refundBounty",
      "discriminator": [
        167,
        234,
        121,
        108,
        247,
        216,
        216,
        124
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true,
          "relations": [
            "bounty"
          ]
        },
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "account",
                "path": "bounty.id",
                "account": "bounty"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "submitWork",
      "discriminator": [
        158,
        80,
        101,
        51,
        114,
        130,
        101,
        253
      ],
      "accounts": [
        {
          "name": "worker",
          "signer": true
        },
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "bounty.creator",
                "account": "bounty"
              },
              {
                "kind": "account",
                "path": "bounty.id",
                "account": "bounty"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "submissionHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "bounty",
      "discriminator": [
        237,
        16,
        105,
        198,
        19,
        69,
        242,
        234
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidReward",
      "msg": "The reward must be greater than zero"
    },
    {
      "code": 6001,
      "name": "invalidDeadline",
      "msg": "The deadline must be in the future"
    },
    {
      "code": 6002,
      "name": "bountyNotOpen",
      "msg": "This bounty is not open for submissions"
    },
    {
      "code": 6003,
      "name": "creatorCannotSubmit",
      "msg": "The creator cannot submit work to their own bounty"
    },
    {
      "code": 6004,
      "name": "submissionMissing",
      "msg": "The bounty has no worker submission to approve"
    },
    {
      "code": 6005,
      "name": "workerMismatch",
      "msg": "The supplied worker is not the bounty's submitter"
    },
    {
      "code": 6006,
      "name": "escrowUnderfunded",
      "msg": "The bounty escrow cannot cover this payout while preserving rent"
    },
    {
      "code": 6007,
      "name": "arithmeticOverflow",
      "msg": "The lamport balance calculation overflowed"
    },
    {
      "code": 6008,
      "name": "deadlineNotReached",
      "msg": "The bounty deadline has not passed"
    },
    {
      "code": 6009,
      "name": "bountyExpired",
      "msg": "The bounty deadline has passed"
    }
  ],
  "types": [
    {
      "name": "bounty",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "worker",
            "type": "pubkey"
          },
          {
            "name": "rewardLamports",
            "type": "u64"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "submissionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "bountyStatus"
              }
            }
          }
        ]
      }
    },
    {
      "name": "bountyStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "submitted"
          },
          {
            "name": "paid"
          },
          {
            "name": "refunded"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "bountySeed",
      "type": "bytes",
      "value": "[98, 111, 117, 110, 116, 121]"
    }
  ]
};
