/**
 * Cursor Canvas source (TypeScript + React).
 * Cursor only renders this as a live sidebar from its project canvases/
 * folder. For sharing, open docs/online-mode.html in a browser.
 */
import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
} from "cursor/canvas";

export default function OnlineModeArchitecture() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>KartBlitz online mode</H1>
        <Text tone="secondary">
          Server-authoritative simulation on a Cloudflare Durable Object. Clients
          predict locally and interpolate remotes from a 30 Hz binary snapshot stream.
        </Text>
      </Stack>
      <Row gap={12} wrap>
        <Stat value="60 Hz" label="DO physics (Alarm)" />
        <Stat value="30 Hz" label="Binary snapshots + inputs" />
        <Stat value="~60–120 ms" label="Adaptive remote delay" />
        <Stat value="6" label="Players per room" />
      </Row>
      <Callout tone="info">
        Lobby host is admin only (settings / start). Physics runs on the Worker, so a
        laptop tab hitch no longer freezes the race. Open with <Code>?netDebug=1</Code>{" "}
        for delay / bandwidth HUD.
      </Callout>
      <H2>Data flow</H2>
      <Table
        headers={["Step", "Where", "What"]}
        rows={[
          ["1. Input", "online.js tickNet", "All clients send binary input @ 30 Hz"],
          ["2. Apply", "DO onMessage", "Store latest input per connection"],
          ["3. Sim", "DO onAlarm + sim/", "Step RaceSim @ 60 Hz"],
          ["4. Snapshot", "netcodec", "Binary delta state @ 30 Hz to all clients"],
          ["5. Present", "interpolateRemoteKarts", "Adaptive delay; ≤50 ms extrapolate"],
          ["6. Correct", "reconcileLocalKart", "Critically-damped blend / snap"],
        ]}
        rowTone={["info", "info", "success", "success", "warning", "warning"]}
      />
      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader trailing={<Pill tone="success">Payload</Pill>}>Rates & codec</CardHeader>
          <CardBody>
            <Text tone="secondary">
              Quantized pose (cm / angle uint16), cold fields on change or every 16 ticks.
              Inputs are ~12-byte binary frames.
            </Text>
          </CardBody>
        </Card>
        <Card>
          <CardHeader trailing={<Pill>Interp</Pill>}>Adaptive delay</CardHeader>
          <CardBody>
            <Text tone="secondary">
              Delay tracks jitter EMA (~60–200 ms). Underrun: dead-reckon remotes ≤50 ms,
              then grow delay instead of freezing forever.
            </Text>
          </CardBody>
        </Card>
      </Grid>
      <H2>Worker room</H2>
      <Table
        headers={["Message", "Who", "Action"]}
        rows={[
          ["hello / ready / lobbySettings", "Players / admin", "Lobby roster + settings"],
          ["startRace + trackBake", "Admin, 2+ ready", "Spawn OnlineRaceSim, Alarm loop"],
          ["input (binary)", "Anyone racing", "Apply to sim input map"],
          ["state (binary)", "DO → all", "Authoritative snapshot broadcast"],
          ["raceEnded / returnLobby", "DO or admin", "Stop Alarm, lobby reset"],
        ]}
      />
      <Divider />
      <H3>Files</H3>
      <Table
        headers={["File", "Role"]}
        rows={[
          ["party/server.ts", "Lobby + DO authority + Alarm tick"],
          ["sim/*", "Pure online physics"],
          ["party/netcodec.ts / online-codec.js", "Binary protocol"],
          ["online.js", "WS client, interp, reconcile, metrics"],
          ["KartBlitz.html", "Render, local prediction, track bake"],
        ]}
      />
      <Text tone="tertiary" size="small">
        Source: KartBlitz server-authoritative online · INPUT_HZ 30 · STATE_HZ 30 ·
        SIM_HZ 60 · INTERP ~60–200 ms · SNAP_BUF 24
      </Text>
    </Stack>
  );
}
