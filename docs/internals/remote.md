# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Cloudbox wake-on-connect

A saved T3 Connect environment can carry a device-local wake policy. The easiest way to attach one is
Settings → Connections: the environment row shows **Set up wake-on-connect…** (or **Edit wake
policy** once configured) and asks for the wake service URL, the cloudbox name, and the wake secret.
With a policy in place the row shows the host state read from the service's read-only
`GET /status/<name>` endpoint — Asleep, Waking…, Awake, Stopped — polled every 30 seconds while the
page is visible (every 5 seconds while a wake is pending), plus a **Wake** button. The button is the
same explicit intent as Connect: it arms the one-shot wake and retries the relay connection. The
page never wakes the host by merely being open.

The desktop client can also attach the policy at startup without the UI. Start the desktop process
with all three required variables:

```sh
export CLOUDBOX_WAKE_URL="https://wake.example.com"
export CLOUDBOX_WAKE_NAME="konan-dev"
export CLOUDBOX_WAKE_SECRET="replace-with-the-bearer-secret"
# Then launch the desktop app from this environment (for example, `vp run dev:desktop`).
```

`CLOUDBOX_WAKE_URL` is the service base URL; the client posts to
`<CLOUDBOX_WAKE_URL>/wake/<CLOUDBOX_WAKE_NAME>`. The target must be matched before the policy is
attached. Set `CLOUDBOX_WAKE_ENVIRONMENT_ID` to the stable T3 Connect environment ID for an exact
match. When it is omitted, the T3 Connect environment label must exactly equal
`CLOUDBOX_WAKE_NAME`.

Set the variables before adding the environment from the T3 Connect list. If the environment was
already saved, remove it and add it again. The resulting `wakePolicy` is device-local catalog data;
it is encrypted by desktop secure storage, is not synced through the relay, and is never included in
connection logs. Mobile does not inherit this desktop policy.

Only the explicit Connect action arms the one-shot intent. The resolver consumes that intent before
relay bootstrap, sends one wake request with a five-second timeout and no retries, and then continues
the ordinary connection attempt regardless of the wake result. Automatic supervisor retries,
background reconnects, and application-resume probes do not arm another wake. A `202 resuming`
response relies on the normal retry ladder: follow-up attempts happen after about 3, 7, 15, and 31
seconds cumulatively, then continue every 16 seconds until the tunnel returns.
