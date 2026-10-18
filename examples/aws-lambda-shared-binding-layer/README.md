# AWS Lambda shared binding Layer

Two Lambda Functions provide one module-level binding Layer. This example
demonstrates the per-host grant guarantee: a host's bindings are built for
that host, so each Function that provides the Layer gets its own IAM
statement and environment variable.

`src/Notifier.ts` defines `NotifierSQS` with `Layer.effect`. Building it
declares the `Notifications` queue and binds `SQS.SendMessage` to it.
`ProducerA` and `ProducerB` each provide that same Layer value in their init
(`src/producer.ts`).

## Deploy

```sh
bun run deploy --profile testing
```

The plan shows one `Allow(<Function>, AWS.SQS.SendMessage(Notifications))`
binding and a `Notifications_queueUrl` env variable on each Function. After
deploy, each Function's role carries an inline `sqs:SendMessage` statement on
the queue ARN, and requesting either Function URL sends a message:

```sh
curl <producerA.url>
# {"producer":"ProducerA","messageId":"..."}
curl <producerB.url>
# {"producer":"ProducerB","messageId":"..."}
```

## Destroy

```sh
bun run destroy --profile testing
```
