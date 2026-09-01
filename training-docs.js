/**
 * Full training manual content for training.html (single docs source of truth).
 */
export const DOC_SECTIONS = [
  {
    id: "getting-started",
    title: "Getting Started",
    html: `
<h2>What is this?</h2>
<p>KartBlitz ML Training Lab teaches you to build AI drivers using <strong>Imitation Learning (IL)</strong> and <strong>Reinforcement Learning (RL)</strong>. You record human laps, train models on your GPU with Python, then evaluate policies here or in the main game.</p>
<h2>Prerequisites</h2>
<ul>
  <li><strong>Node.js</strong> 18+ (for sim bundle and env server)</li>
  <li><strong>Python</strong> 3.10+ with pip</li>
  <li><strong>NVIDIA GPU</strong> + CUDA (recommended — e.g. RTX 5070 laptop)</li>
  <li>Git (optional, for version control)</li>
</ul>
<h2>First-time repo setup</h2>
<pre data-copy><code>cd KartBlitz
npm install
npm run tracks:export
npm run sim:browser</code></pre>
<h2>Folder layout</h2>
<pre><code>KartBlitz/
  training.html          ← you are here (tools + full manual)
  training-app.js        ← interactive lab logic
  training-docs.js       ← doc content
  online-sim.js          ← physics bundle (auto-built)
  sim/rl/
    env.mjs              ← observation, actions, reward
    demos/               ← save human demo JSON here
    models/              ← PyTorch checkpoints
    policy.json          ← exported policy for eval / game
  ml/
    train_bc.py          ← Behavior Cloning
    train_reinforce.py   ← REINFORCE (PyTorch)
    train_ppo.py         ← PPO
    policy_export.py     ← export to policy.json
  scripts/
    ml-env-server.mjs    ← sim API for Python
    rl-train.mjs         ← Node REINFORCE baseline</code></pre>
`,
  },
  {
    id: "full-workflow",
    title: "Full Workflow",
    html: `
<h2>Zero → trained policy (checklist)</h2>
<ol>
  <li><strong>Build sim</strong> — <code>npm run sim:browser</code> (once, or after track changes)</li>
  <li><strong>Record demos</strong> — use <em>Record Demo</em> tab; save JSON files to <code>sim/rl/demos/</code></li>
  <li><strong>Install Python deps</strong> — <code>pip install -r ml/requirements.txt</code></li>
  <li><strong>Train (BC)</strong> — <code>python ml/train_bc.py --demos sim/rl/demos</code></li>
  <li><strong>Export</strong> — <code>python ml/policy_export.py --checkpoint sim/rl/models/bc_best.pt</code></li>
  <li><strong>Evaluate</strong> — load <code>sim/rl/policy.json</code> in <em>Evaluate Policy</em> tab</li>
  <li><strong>Optional RL</strong> — start env server, run PPO or REINFORCE (see algorithm guides)</li>
  <li><strong>Deploy in game</strong> — enable ML AI in Custom Race (see Environment Setup & Deploy)</li>
</ol>
<h2>Success at each step</h2>
<table>
  <tr><th>Step</th><th>Success looks like</th><th>If it fails</th></tr>
  <tr><td>sim:browser</td><td><code>online-sim.js</code> exists</td><td>Run <code>npm install</code>, check Node version</td></tr>
  <tr><td>Record demo</td><td>JSON downloads with hundreds of frames</td><td>Complete a full lap before saving</td></tr>
  <tr><td>train_bc</td><td>Val accuracy &gt; 60%</td><td>Record more clean on-track demos</td></tr>
  <tr><td>Evaluate</td><td>Kart moves forward, follows track roughly</td><td>Try BC first before RL</td></tr>
</table>
`,
  },
  {
    id: "env-setup",
    title: "Environment Setup & Deploy",
    html: `
<h2>Python environment</h2>
<pre data-copy><code>python -m venv .venv
.venv\\Scripts\\activate
pip install -r ml/requirements.txt</code></pre>
<h2>Verify GPU (PyTorch + CUDA)</h2>
<pre data-copy><code>python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"</code></pre>
<h2>Start sim server (required for RL)</h2>
<p>Terminal 1 — keep running while training RL:</p>
<pre data-copy><code>npm run ml:env</code></pre>
<p>Server listens on <code>http://127.0.0.1:8765</code>. Python scripts POST JSON commands: <code>reset</code>, <code>step</code>, <code>observe</code>.</p>
<h2>Rebuild sim after track edits</h2>
<pre data-copy><code>npm run tracks:export
npm run sim:browser</code></pre>
<h2>Deploy policy into the game</h2>
<ol>
  <li>Export policy to <code>sim/rl/policy.json</code> via <code>python ml/policy_export.py</code></li>
  <li>In Custom Race → AI mode, set <strong>AI Driver: ML Policy</strong> (uses <code>sim/rl/policy.json</code>)</li>
  <li>Or call from console: <code>race.aiDriver = 'ml'</code> before race start (dev)</li>
</ol>
<p>Scripted AI remains the default fallback if policy file is missing.</p>
`,
  },
  {
    id: "recording-demos",
    title: "Recording Demos",
    html: `
<h2>Tips for good imitation data</h2>
<ul>
  <li>Stay on track — off-track frames teach bad habits</li>
  <li>Record 3–5 clean laps per track before training</li>
  <li>Use consistent medium tyres / dry weather (defaults in recorder)</li>
  <li>Smooth steering — avoid rapid left/right toggling</li>
</ul>
<h2>Demo JSON schema (v1)</h2>
<pre><code>{
  "version": 1,
  "trackId": 0,
  "weather": "dry",
  "tyreId": "med",
  "dt": 0.016667,
  "frames": [
    {
      "inputs": { "up": true, "down": false, "left": false, "right": true },
      "obs": [ /* 10 floats */ ],
      "action": 2
    }
  ]
}</code></pre>
<p>Save downloaded files to <code>sim/rl/demos/</code>. Each frame stores precomputed <code>obs</code> and discrete <code>action</code> aligned with RL training.</p>
<h2>Time Trial export (main game)</h2>
<p>After a clean Time Trial lap, use <strong>Export ML Demo</strong> on the results screen. Inputs are logged during the lap automatically.</p>
`,
  },
  {
    id: "obs-action-ref",
    title: "Observation & Action Reference",
    html: `
<h2>Observations (10 dimensions)</h2>
<table>
  <tr><th>#</th><th>Name</th><th>Range</th><th>Meaning</th></tr>
  <tr><td>0</td><td>speed_norm</td><td>−1…1</td><td>Speed / max speed</td></tr>
  <tr><td>1</td><td>lateral_error</td><td>−1.5…1.5</td><td>Distance from centreline / half track width</td></tr>
  <tr><td>2</td><td>heading_sin</td><td>−1…1</td><td>sin(heading − track tangent)</td></tr>
  <tr><td>3</td><td>heading_cos</td><td>−1…1</td><td>cos(heading − track tangent)</td></tr>
  <tr><td>4</td><td>curvature_now</td><td>0…1</td><td>Track bend at kart position</td></tr>
  <tr><td>5</td><td>curvature_40</td><td>0…1</td><td>Bend 40 units ahead</td></tr>
  <tr><td>6</td><td>curvature_80</td><td>0…1</td><td>Bend 80 units ahead</td></tr>
  <tr><td>7</td><td>curvature_160</td><td>0…1</td><td>Bend 160 units ahead</td></tr>
  <tr><td>8</td><td>off_track</td><td>0 or 1</td><td>On grass?</td></tr>
  <tr><td>9</td><td>lap_progress</td><td>0…1</td><td>Fraction along current lap</td></tr>
</table>
<h2>Actions (9 discrete)</h2>
<table>
  <tr><th>Idx</th><th>Name</th><th>Throttle</th><th>Brake</th><th>Steer</th></tr>
  <tr><td>0</td><td>thr-L</td><td>✓</td><td></td><td>left</td></tr>
  <tr><td>1</td><td>thr</td><td>✓</td><td></td><td>straight</td></tr>
  <tr><td>2</td><td>thr-R</td><td>✓</td><td></td><td>right</td></tr>
  <tr><td>3</td><td>coast-L</td><td></td><td></td><td>left</td></tr>
  <tr><td>4</td><td>coast</td><td></td><td></td><td>straight</td></tr>
  <tr><td>5</td><td>coast-R</td><td></td><td></td><td>right</td></tr>
  <tr><td>6</td><td>brk-L</td><td></td><td>✓</td><td>left</td></tr>
  <tr><td>7</td><td>brk</td><td></td><td>✓</td><td>straight</td></tr>
  <tr><td>8</td><td>brk-R</td><td></td><td>✓</td><td>right</td></tr>
</table>
<h2>Reward (RL)</h2>
<ul>
  <li><code>+ dProg × 0.035</code> — progress along spline</li>
  <li><code>− 0.012</code> — per-step time penalty</li>
  <li><code>− 0.35</code> — off track</li>
  <li><code>− 0.55</code> — completely off track</li>
  <li><code>− 0.08</code> — wrong-way heading</li>
  <li><code>+ 8</code> — lap complete</li>
  <li><code>− 4</code> — stuck timeout</li>
</ul>
`,
  },
  {
    id: "algo-bc",
    title: "Behavior Cloning (IL)",
    html: `
<h2>What it is</h2>
<p>Supervised learning: given observation vectors from your demos, predict which action the human took. Fast to train, great first algorithm.</p>
<h2>When it works / fails</h2>
<p><strong>Works:</strong> demos cover the states you care about; clean racing lines.</p>
<p><strong>Fails:</strong> covariate shift — policy drifts off expert line and doesn't recover. Fix with more demos or DAgger.</p>
<h2>Command</h2>
<pre data-copy><code>python ml/train_bc.py --demos sim/rl/demos --epochs 80 --batch-size 256 --lr 0.001</code></pre>
<h2>Flags</h2>
<ul>
  <li><code>--demos</code> — folder of demo JSON files</li>
  <li><code>--epochs</code> — training epochs (default 80)</li>
  <li><code>--hidden</code> — MLP hidden size (default 128)</li>
  <li><code>--out</code> — checkpoint path (default sim/rl/models/bc_best.pt)</li>
</ul>
<h2>Expected output</h2>
<p>Validation accuracy 70%+ on held-out frames is a good start. Checkpoints save to <code>sim/rl/models/</code>. TensorBoard: <code>tensorboard --logdir ml/runs</code></p>
`,
  },
  {
    id: "algo-reinforce",
    title: "REINFORCE (RL)",
    html: `
<h2>What it is</h2>
<p>Policy gradient method: sample actions, compute returns, increase probability of actions that led to reward. High variance — good for learning the idea, not always SOTA.</p>
<h2>Node baseline (linear policy)</h2>
<pre data-copy><code>npm run rl:train -- --episodes 1500 --track 0 --seconds 18
npm run rl:train -- --eval --load sim/rl/policy.json --track 0</code></pre>
<h2>PyTorch (GPU, MLP)</h2>
<p>Terminal 1: <code>npm run ml:env</code></p>
<pre data-copy><code>python ml/train_reinforce.py --track 0 --episodes 500 --lr 0.0003</code></pre>
<h2>Hyperparameters</h2>
<ul>
  <li><code>--lr</code> — learning rate</li>
  <li><code>--gamma</code> — discount factor (default 0.992)</li>
  <li><code>--entropy</code> — exploration bonus</li>
</ul>
`,
  },
  {
    id: "algo-ppo",
    title: "PPO (RL)",
    html: `
<h2>Why PPO after BC?</h2>
<p>PPO (Proximal Policy Optimization) is stable on-policy RL. Use BC to bootstrap, then PPO to improve beyond human demos.</p>
<h2>Command</h2>
<p>Terminal 1: <code>npm run ml:env</code></p>
<pre data-copy><code>python ml/train_ppo.py --track 0 --steps 300000 --lr 0.0003</code></pre>
<h2>On RTX 5070 laptop</h2>
<p>Expect ~30–60 min for 300k steps depending on CPU sim throughput. GPU trains the network; Node sim steps physics.</p>
<h2>TensorBoard</h2>
<pre data-copy><code>tensorboard --logdir ml/runs</code></pre>
<p>Watch <code>episode_reward</code> and <code>lap_progress</code> — should trend upward over time.</p>
`,
  },
  {
    id: "algo-dagger",
    title: "DAgger (Advanced IL)",
    html: `
<h2>When BC isn't enough</h2>
<p>DAgger (Dataset Aggregation): run BC policy, record states where it deviates, ask human/expert for correct actions, retrain. Reduces covariate shift.</p>
<p><strong>Status:</strong> planned advanced exercise — implement after BC + PPO basics.</p>
<h2>High-level loop</h2>
<ol>
  <li>Train BC policy</li>
  <li>Roll out policy, save (obs, expert_action) on visited states</li>
  <li>Merge with original demos</li>
  <li>Retrain BC</li>
  <li>Repeat 3–5 iterations</li>
</ol>
`,
  },
  {
    id: "export-eval",
    title: "Export & Evaluate",
    html: `
<h2>Export checkpoint → policy.json</h2>
<pre data-copy><code>python ml/policy_export.py --checkpoint sim/rl/models/bc_best.pt --out sim/rl/policy.json</code></pre>
<p>Supports linear (REINFORCE) and MLP (BC/PPO) exports. Game and Evaluate tab load this file.</p>
<h2>Evaluate in this page</h2>
<p>Use <em>Evaluate Policy</em> → load <code>sim/rl/policy.json</code> → watch AI drive on canvas.</p>
<h2>Evaluate in game</h2>
<p>Custom Race → AI → set driver type to <strong>ML Policy</strong>.</p>
`,
  },
  {
    id: "tensorboard-debug",
    title: "TensorBoard & Debugging",
    html: `
<h2>Launch TensorBoard</h2>
<pre data-copy><code>tensorboard --logdir ml/runs</code></pre>
<h2>Metrics per algorithm</h2>
<ul>
  <li><strong>BC:</strong> train/val loss, accuracy</li>
  <li><strong>REINFORCE:</strong> episode reward, lap progress</li>
  <li><strong>PPO:</strong> policy loss, value loss, episode reward</li>
</ul>
<h2>Troubleshooting</h2>
<table>
  <tr><th>Problem</th><th>Fix</th></tr>
  <tr><td>CUDA not available</td><td>Install PyTorch with CUDA: <code>pip install torch --index-url https://download.pytorch.org/whl/cu124</code></td></tr>
  <tr><td>online-sim.js missing</td><td><code>npm run sim:browser</code></td></tr>
  <tr><td>ml:env connection refused</td><td>Start <code>npm run ml:env</code> in separate terminal</td></tr>
  <tr><td>Demo won't load</td><td>Check version=1, trackId matches, frames array non-empty</td></tr>
  <tr><td>Policy drives off track</td><td>More demos, train BC first, check val accuracy</td></tr>
  <tr><td>Track missing</td><td><code>npm run tracks:export</code></td></tr>
</table>
`,
  },
  {
    id: "learning-path",
    title: "Learning Path",
    html: `
<h2>Recommended order</h2>
<ol>
  <li><strong>Record demos</strong> — understand obs/action space hands-on</li>
  <li><strong>Behavior Cloning</strong> — supervised learning, train/val split, overfitting</li>
  <li><strong>Evaluate BC</strong> — see sim-to-real gap</li>
  <li><strong>REINFORCE (Node)</strong> — policy gradients with simple linear policy</li>
  <li><strong>REINFORCE (PyTorch)</strong> — same idea on GPU with MLP</li>
  <li><strong>PPO</strong> — stable RL, advantage estimation, clipping</li>
  <li><strong>DAgger</strong> — iterative IL (advanced)</li>
</ol>
<p>Before PPO, you should understand: observations, discrete actions, reward shaping, and why BC alone can fail off the racing line.</p>
`,
  },
  {
    id: "faq",
    title: "FAQ / Glossary",
    html: `
<dl>
  <dt>Policy</dt><dd>Function mapping observations → actions (neural net or linear weights).</dd>
  <dt>Observation</dt><dd>10-float vector describing kart state relative to track.</dd>
  <dt>Action</dt><dd>One of 9 discrete throttle/brake/steer combos.</dd>
  <dt>Episode</dt><dd>One lap attempt from start to finish or timeout.</dd>
  <dt>Checkpoint</dt><dd>Saved model weights (.pt file) during training.</dd>
  <dt>Imitation Learning</dt><dd>Learn from expert demos (Behavior Cloning, DAgger).</dd>
  <dt>Reinforcement Learning</dt><dd>Learn from reward signal (REINFORCE, PPO).</dd>
  <dt>Covariate shift</dt><dd>BC policy visits states not in training data → errors compound.</dd>
</dl>
`,
  },
];

export const TOOL_SECTIONS = [
  { id: "tool-record", title: "Record Demo" },
  { id: "tool-review", title: "Review Demos" },
  { id: "tool-eval", title: "Evaluate Policy" },
];

export function allNavItems() {
  return [...TOOL_SECTIONS, ...DOC_SECTIONS];
}
