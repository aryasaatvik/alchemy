// Captured from Samva fork 994a83ff04fa1a9b004403775f7e622d4d2e1843.
// Start bytes were recorded at Distilled's HTTP boundary. Histories and callback
// requests came from that fork's runner and sender against the pinned Floci image.
// Only operation events relevant to replay are retained from each history.
export const golden = {
  start: {
    body: '{"workflow":"Probe","executionId":"cc9dd70fae809d2b4a87737870af00b2","payload":{"id":"gold-success","mode":"success"}}',
    qualifier: "live",
    name: "Probe-cc9dd70fae809d2b4a87737870af00b2",
  },
  id: "cc9dd70fae809d2b4a87737870af00b2",
  native: '{"$alchemy":{"workflow":"Golden"},"params":{"text":"[\\"already JSON\\"]","count":3}}',
  names: [
    {
      workflow: "A/B: 🕒",
      id: "id with/space",
      name: "A_B____-id_with_space",
    },
    {
      workflow: "WorkflowWorkflowWorkflowWorkflowWorkflowWorkflowWorkflowWorkflowWorkflowWorkflow",
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "WorkflowWorkflowWorkflowWorkflowWorkflowWorkflowWorkflo-e0807558",
    },
  ],
  success: '"{\\"_tag\\":\\"Success\\",\\"value\\":\\"approved\\"}"',
  failure:
    '"{\\"_tag\\":\\"Failure\\",\\"cause\\":[{\\"_tag\\":\\"Fail\\",\\"error\\":{\\"_tag\\":\\"Rejected\\",\\"reason\\":\\"no\\"}}]}"',
  callback: {
    success: '{"_tag":"Success","value":"approved"}',
    fail: '{"ErrorMessage":"alchemy/DeferredFailure:{\\"_tag\\":\\"Failure\\",\\"cause\\":[{\\"_tag\\":\\"Fail\\",\\"error\\":{\\"_tag\\":\\"Rejected\\",\\"reason\\":\\"no\\"}}]}","ErrorType":"alchemy/DeferredFailure"}',
  },
  notYetWaiting: {
    workflowName: "Probe",
    executionId: "a62070725e74b48e6e08676e652e23f1",
    deferredName: "approval",
    _tag: "NotYetWaiting",
  },
  histories: {
    clock: [
      {
        EventType: "WaitStarted",
        SubType: "Wait",
        EventId: 2,
        Id: "c4ca4238a0b92382",
        Name: "DurableClock/nap",
        EventTimestamp: "2026-11-21T09:56:32.661Z",
        WaitStartedDetails: {
          Duration: 2,
          ScheduledEndTimestamp: "2026-11-21T09:56:34.661Z",
        },
      },
      {
        EventType: "WaitSucceeded",
        SubType: "Wait",
        EventId: 4,
        Id: "c4ca4238a0b92382",
        Name: "DurableClock/nap",
        EventTimestamp: "2026-11-21T09:56:35.410Z",
        WaitSucceededDetails: {
          Duration: 2,
        },
      },
    ],
    success: [
      {
        EventType: "ContextStarted",
        SubType: "WaitForCallback",
        EventId: 2,
        Id: "c4ca4238a0b92382",
        Name: "approval",
        EventTimestamp: "2026-11-21T09:56:35.963Z",
        ContextStartedDetails: {},
      },
      {
        EventType: "CallbackStarted",
        SubType: "Callback",
        EventId: 3,
        Id: "ea66c06c1e1c05fa",
        EventTimestamp: "2026-11-21T09:56:35.963Z",
        ParentId: "c4ca4238a0b92382",
        CallbackStartedDetails: {
          CallbackId:
            "YXJuOmF3czpsYW1iZGE6dXMtZWFzdC0xOjAwMDAwMDAwMDAwMDpmdW5jdGlvbjphbGNoZW15LXdvcmtmbG93LXByMy0wMzRjNjkwODoxL2R1cmFibGUtZXhlY3V0aW9uL1Byb2JlLWNjOWRkNzBmYWU4MDlkMmI0YTg3NzM3ODcwYWYwMGIyLzg2ODgzOGFmLTU5OWYtNDcwOS1hMGQxLTMyYTU4NDkwMjNiMXxlYTY2YzA2YzFlMWMwNWZhfGRkYjExODYzLTZiZTMtNGY3ZS1iODA0LTcyNjU5MDI1ZDVmMw==",
        },
      },
      {
        EventType: "StepStarted",
        SubType: "Step",
        EventId: 4,
        Id: "98c6f2c2287f4c73",
        EventTimestamp: "2026-11-21T09:56:35.967Z",
        ParentId: "c4ca4238a0b92382",
        StepStartedDetails: {},
      },
      {
        EventType: "StepSucceeded",
        SubType: "Step",
        EventId: 5,
        Id: "98c6f2c2287f4c73",
        EventTimestamp: "2026-11-21T09:56:35.967Z",
        ParentId: "c4ca4238a0b92382",
        StepSucceededDetails: {
          RetryDetails: {
            CurrentAttempt: 1,
          },
        },
      },
      {
        EventType: "CallbackSucceeded",
        SubType: "Callback",
        EventId: 7,
        Id: "ea66c06c1e1c05fa",
        EventTimestamp: "2026-11-21T09:56:36.196Z",
        ParentId: "c4ca4238a0b92382",
        CallbackSucceededDetails: {
          Result: {
            Truncated: true,
          },
        },
      },
      {
        EventType: "ContextSucceeded",
        SubType: "WaitForCallback",
        EventId: 8,
        Id: "c4ca4238a0b92382",
        Name: "approval",
        EventTimestamp: "2026-11-21T09:56:36.211Z",
        ContextSucceededDetails: {
          Result: {
            Truncated: true,
          },
        },
      },
    ],
    fail: [
      {
        EventType: "ContextStarted",
        SubType: "WaitForCallback",
        EventId: 2,
        Id: "c4ca4238a0b92382",
        Name: "approval",
        EventTimestamp: "2026-11-21T09:56:36.750Z",
        ContextStartedDetails: {},
      },
      {
        EventType: "CallbackStarted",
        SubType: "Callback",
        EventId: 3,
        Id: "ea66c06c1e1c05fa",
        EventTimestamp: "2026-11-21T09:56:36.750Z",
        ParentId: "c4ca4238a0b92382",
        CallbackStartedDetails: {
          CallbackId:
            "YXJuOmF3czpsYW1iZGE6dXMtZWFzdC0xOjAwMDAwMDAwMDAwMDpmdW5jdGlvbjphbGNoZW15LXdvcmtmbG93LXByMy0wMzRjNjkwODoxL2R1cmFibGUtZXhlY3V0aW9uL1Byb2JlLTU5N2Y2MzQwZDU0OWZhYzFjN2E2ODAxZDI5Nzg4MDBkLzM5ZWEzMmEyLWVlODktNDI5ZS1hZWQyLTZlNGVlOGY4ZGU1NXxlYTY2YzA2YzFlMWMwNWZhfDljNzcyYjI5LTdlZDYtNDJjYy04YjA5LWUyNjgyNjg2MDcxZQ==",
        },
      },
      {
        EventType: "StepStarted",
        SubType: "Step",
        EventId: 4,
        Id: "98c6f2c2287f4c73",
        EventTimestamp: "2026-11-21T09:56:36.755Z",
        ParentId: "c4ca4238a0b92382",
        StepStartedDetails: {},
      },
      {
        EventType: "StepSucceeded",
        SubType: "Step",
        EventId: 5,
        Id: "98c6f2c2287f4c73",
        EventTimestamp: "2026-11-21T09:56:36.755Z",
        ParentId: "c4ca4238a0b92382",
        StepSucceededDetails: {
          RetryDetails: {
            CurrentAttempt: 1,
          },
        },
      },
      {
        EventType: "CallbackFailed",
        SubType: "Callback",
        EventId: 7,
        Id: "ea66c06c1e1c05fa",
        EventTimestamp: "2026-11-21T09:56:36.984Z",
        ParentId: "c4ca4238a0b92382",
        CallbackFailedDetails: {
          Error: {
            Truncated: true,
          },
        },
      },
      {
        EventType: "ContextFailed",
        SubType: "WaitForCallback",
        EventId: 8,
        Id: "c4ca4238a0b92382",
        Name: "approval",
        EventTimestamp: "2026-11-21T09:56:37.001Z",
        ContextFailedDetails: {
          Error: {
            Truncated: true,
          },
        },
      },
    ],
    suspension: [
      {
        EventType: "StepStarted",
        SubType: "Step",
        EventId: 2,
        Id: "c4ca4238a0b92382",
        Name: "suspension/1",
        EventTimestamp: "2026-11-21T09:56:47.190Z",
        StepStartedDetails: {},
      },
      {
        EventType: "StepSucceeded",
        SubType: "Step",
        EventId: 3,
        Id: "c4ca4238a0b92382",
        Name: "suspension/1",
        EventTimestamp: "2026-11-21T09:56:47.190Z",
        StepSucceededDetails: {
          Result: {
            Truncated: true,
          },
          RetryDetails: {
            CurrentAttempt: 1,
          },
        },
      },
      {
        EventType: "ContextStarted",
        SubType: "WaitForCallback",
        EventId: 4,
        Id: "c81e728d9d4c2f63",
        Name: "suspension/1/suspended-0",
        EventTimestamp: "2026-11-21T09:56:47.194Z",
        ContextStartedDetails: {},
      },
      {
        EventType: "CallbackStarted",
        SubType: "Callback",
        EventId: 5,
        Id: "8fbdbf5573b18fae",
        EventTimestamp: "2026-11-21T09:56:47.194Z",
        ParentId: "c81e728d9d4c2f63",
        CallbackStartedDetails: {
          CallbackId:
            "YXJuOmF3czpsYW1iZGE6dXMtZWFzdC0xOjAwMDAwMDAwMDAwMDpmdW5jdGlvbjphbGNoZW15LXdvcmtmbG93LXByMy0wMzRjNjkwODoxL2R1cmFibGUtZXhlY3V0aW9uL1Byb2JlLWU3ZWQ5OWNkYTJjYmU2NTYxMTBlMjYxNTc1NTYyNWFhLzc1MGNlZTNkLTE2YzMtNGJjMS05MTRmLWI4ZjViY2Y1MDUzY3w4ZmJkYmY1NTczYjE4ZmFlfDkwNDZkNzgzLTJjZTMtNGQxOS04MzMwLWIyN2E1MTQ2NWMyOQ==",
        },
      },
      {
        EventType: "StepStarted",
        SubType: "Step",
        EventId: 6,
        Id: "3c46a0407be60a1f",
        EventTimestamp: "2026-11-21T09:56:47.198Z",
        ParentId: "c81e728d9d4c2f63",
        StepStartedDetails: {},
      },
      {
        EventType: "StepSucceeded",
        SubType: "Step",
        EventId: 7,
        Id: "3c46a0407be60a1f",
        EventTimestamp: "2026-11-21T09:56:47.198Z",
        ParentId: "c81e728d9d4c2f63",
        StepSucceededDetails: {
          RetryDetails: {
            CurrentAttempt: 1,
          },
        },
      },
    ],
  },
} as const;
