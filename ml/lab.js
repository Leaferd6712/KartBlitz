(function () {
  'use strict';

  const ENABLE_KEY = 'kartblitz_ml_lab_enabled';
  const PLAYER_MODEL_KEY = 'kartblitz_ml_player_model';
  const TRAINER_URL_KEY = 'kartblitz_ml_trainer_url';
  const TRAINER_CODE_KEY = 'kartblitz_ml_pairing_code';
  const Runtime = window.KartBlitzMLRuntime;
  if (!Runtime) { console.error('KartBlitz ML runtime did not load.'); return; }

  function read(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  function parseStoredModel() {
    try {
      const model = JSON.parse(read(PLAYER_MODEL_KEY) || 'null');
      if (model) Runtime.validateModel(model);
      return model;
    } catch (_) { return null; }
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  const storedModel = parseStoredModel();
  const state = {
    enabled: read(ENABLE_KEY) === '1',
    selectedModel: 'ours',
    selectedTrack: 0,
    ourModel: Runtime.DEFAULT_MODEL,
    playerModel: storedModel,
    trainerUrl: read(TRAINER_URL_KEY) || 'http://127.0.0.1:8765',
    pairingCode: read(TRAINER_CODE_KEY) || '',
    trainer: null,
    job: null,
    pollTimer: null,
    tracks: null,
    snapshots: storedModel && storedModel.training && Array.isArray(storedModel.training.replay) ? storedModel.training.replay : [],
    demonstrations: [],
    recording: null,
    lessonChoices: { steer: null, pedal: null },
    lessonChecked: false,
    frame: 0,
    raf: 0
  };

  const rewardDefs = [
    ['progress', 'Forward progress', 1.00, 0, 2.5, 'Main signal. Pays for moving forward along the circuit, not just moving quickly. Too low can make the kart passive.'],
    ['speed', 'Useful speed', .20, 0, 1, 'Pays for speed only when the kart is pointing down the track and remains on the road.'],
    ['line', 'Track position', .15, 0, 1, 'Gently favours space away from the edges. High values can prevent faster racing lines.'],
    ['heading', 'Heading alignment', .20, 0, 1, 'Rewards pointing along the local track tangent. Helps early learning and spin recovery.'],
    ['offTrack', 'Off-track penalty', 1.50, 0, 4, 'Cost paid every step outside the road. Very high values can create an overly cautious driver.'],
    ['smoothness', 'Control smoothness', .05, 0, .5, 'Penalises sudden steering, throttle and brake changes. Use a light value so pace still matters.'],
    ['stuck', 'Stuck penalty', 1.00, 0, 4, 'Penalises low speed or backwards progress after a grace period.'],
    ['lap', 'Lap completion', 3.00, 0, 8, 'One-time bonus for a completed lap. This cannot teach driving alone because it is a sparse reward.']
  ];

  const parameterDefs = [
    ['learningRate', 'Learning rate', .0003, .00001, .001, .00001, 'How large each neural-network update is. Too high becomes unstable; too low learns very slowly.'],
    ['gamma', 'Future reward (gamma)', .995, .95, .999, .001, 'How much later rewards matter. 0.995 encourages planning through a sequence of corners instead of chasing the next instant.'],
    ['gaeLambda', 'Advantage smoothing', .95, .80, 1, .01, 'Balances noisy short-term estimates against smoother long-term estimates. 0.95 is a dependable PPO default.'],
    ['clipRange', 'PPO clip range', .20, .05, .40, .01, 'Limits how far the policy may change in one update. Smaller is safer; larger can learn faster but destabilise.'],
    ['entropy', 'Exploration bonus', .008, 0, .04, .001, 'Rewards trying varied controls during training. Too much prevents the driver from becoming precise.'],
    ['horizon', 'Rollout horizon', 256, 64, 512, 64, 'Steps gathered per environment before an update. Longer rollouts improve long-term context but use more memory.'],
    ['numEnvs', 'Parallel environments', 48, 4, 128, 4, 'Independent CPU simulations collecting experience. More increases throughput and RAM use; CUDA handles network updates.'],
    ['imitationEpochs', 'Imitation epochs', 3, 1, 12, 1, 'A short warm-start over the 10% example budget. PPO receives the other 90% so imitation cannot dominate.']
  ];

  const lessonScenarios = {
    straight: { name: 'Open straight', speed: .52, lateral: .04, curve: 0, grip: 1, offTrack: false, steer: 'straight', pedal: 'throttle', target: .98 },
    fastLeft: { name: 'Fast left corner', speed: .94, lateral: .18, curve: -.78, grip: .94, offTrack: false, steer: 'left', pedal: 'brake', target: .48 },
    rightEdge: { name: 'Right bend near the edge', speed: .67, lateral: -.72, curve: .58, grip: .86, offTrack: false, steer: 'right', pedal: 'coast', target: .64 },
    recovery: { name: 'Off-track recovery', speed: .31, lateral: 1.24, curve: -.22, grip: .55, offTrack: true, steer: 'left', pedal: 'coast', target: .42 }
  };

  const phaseLessons = {
    prepare: { title: '1. Prepare observations', plain: 'Each kart turns the game state into the same 24 small numbers. Values are scaled to similar ranges so speed does not overwhelm a tiny curvature signal.', watch: 'Check that every sensor is finite and that training and the browser calculate it the same way.', trap: 'A model can learn the training simulator perfectly and still fail if the real game uses different sensors.' },
    imitate: { title: '2. Copy useful examples (10%)', plain: 'For the first 10% of the experience budget, the network sees a situation and reproduces teacher or player controls. This only gives PPO a safe starting point.', watch: 'Imitation loss should fall, but this phase should remain short.', trap: 'Copying alone cannot become faster than its examples and may copy human mistakes.' },
    rollout: { title: '3. Gather experience', plain: 'Many simulated karts drive with the current policy. Every frame stores what the kart saw, what it did, the reward, and whether the run ended.', watch: 'Reward and finish rate should improve across many updates, not necessarily every single update.', trap: 'Reward can rise through a loophole, so trajectories and race metrics must also be inspected.' },
    update: { title: '4. Reinforcement learning with PPO (90%)', plain: 'Most learning happens here. The critic estimates which situations were promising. PPO increases the chance of better-than-expected actions, but clips each update so the driver does not forget everything at once.', watch: 'A stable run changes gradually. Large swings often mean the learning rate, clip range, or reward is too aggressive.', trap: 'CUDA speeds up the network maths, but it does not decide what reward is correct.' },
    evaluate: { title: '5. Test without teaching', plain: 'The finished policy drives separate randomized runs on every track. Evaluation does not update the weights; it measures whether learning transferred.', watch: 'Use finish rate, median lap, off-track time, and recovery failures together.', trap: 'A high training reward is not proof of fast or human-level driving.' }
  };

  function getTracks() {
    try { if (Array.isArray(TRACKS)) return TRACKS; } catch (_) {}
    return Array.from({ length: 8 }, (_, id) => ({ id, name: `TRACK ${id + 1}` }));
  }

  function lesson(title, text) {
    return `<div class="ml-concept"><strong>${title}</strong><span>${text}</span></div>`;
  }

  function screenMarkup() {
    return `
      <div class="scanlines"></div>
      <button class="back-btn" type="button" onclick="KartBlitzMLLab.close()">&larr; BACK</button>
      <main class="ml-shell">
        <header class="ml-topbar">
          <div><div class="ml-eyebrow">LEARN / TRAIN / VERIFY / RACE</div><h1 class="ml-title">ML LAB</h1><div class="ml-subtitle">Create a continuous-control racing policy, train it with Python and PyTorch, inspect real checkpoints, then race its exported weights.</div></div>
          <span class="ml-badge" id="ml-device-badge">TRAINER OFFLINE</span>
        </header>
        <nav class="ml-tabs" aria-label="ML Lab steps">
          <button class="ml-tab active" data-tab="learn" onclick="KartBlitzMLLab.tab('learn')">1 / LEARN</button><button class="ml-tab" data-tab="build" onclick="KartBlitzMLLab.tab('build')">2 / BUILD</button><button class="ml-tab" data-tab="train" onclick="KartBlitzMLLab.tab('train')">3 / TRAIN</button><button class="ml-tab" data-tab="replay" onclick="KartBlitzMLLab.tab('replay')">4 / WATCH</button><button class="ml-tab" data-tab="race" onclick="KartBlitzMLLab.tab('race')">5 / RACE</button>
        </nav>

        <section class="ml-panel active" data-panel="learn">
          <div class="ml-hero-card"><span class="ml-badge">READ THIS / THE TRAINING IDEA</span><h2>Reinforcement learning is the main event</h2><p>Imitation learning uses the first 10% of the experience budget to stop the new driver from beginning with random crashes. The remaining 90% is PPO reinforcement learning: it drives, receives rewards, and discovers controls that can improve beyond its examples.</p><div class="ml-balance" aria-label="Training emphasis: 10 percent imitation learning and 90 percent reinforcement learning"><span style="width:10%">10% IL</span><strong style="width:90%">90% REINFORCEMENT LEARNING / PPO</strong></div><div class="ml-pipeline"><span>24 SENSORS</span><i>&rarr;</i><span>128 x 128 NETWORK</span><i>&rarr;</i><span>3 CONTROLS</span><i>&rarr;</i><span>REWARD</span></div></div>
          <div class="ml-grid ml-grid-3">
            <article class="ml-card"><span class="ml-badge">OBSERVATION</span><h3>What the driver can sense</h3>${lesson('Where am I?', 'Speed, sideways offset, track-edge margin, heading and yaw rate.')}${lesson('What comes next?', 'Four look-ahead directions and curvature at 80, 180, 360 and up to 700 game units.')}${lesson('What just happened?', 'Previous controls, progress velocity, grip, ERS, DRS, off-track and stuck state.')}<div class="ml-note">World coordinates are excluded. Relative sensors let one policy transfer to every circuit.</div></article>
            <article class="ml-card"><span class="ml-badge player">ACTION</span><h3>Continuous control</h3>${lesson('Steering', 'A smooth value from full left (-1) to full right (+1).')}${lesson('Drive', 'A continuous request that maps to 0-100% throttle.')}${lesson('Brake', 'A separate continuous brake request. Overlap protection reduces throttle when braking.')}<div class="ml-note">The previous nine-button action grid could not make small corrections. Analog control is essential for a fast, stable racing line.</div></article>
            <article class="ml-card"><span class="ml-badge ok">READ THIS / LEARNING</span><h3>Warm up briefly, then learn by racing</h3>${lesson('10% / Imitation warm-start', 'Behaviour cloning gives the untrained network a safe starting line instead of random crashes.')}${lesson('90% / PPO reinforcement learning', 'The driver experiments, receives reward, and strengthens actions that worked better than expected.')}${lesson('Final / Evaluation only', 'Weights are frozen for five randomized tests on every track. No learning is allowed during the exam.')}<div class="ml-note">Passing the training simulator is not proof of human-level pace. The final gate is real in-game lap comparison.</div></article>
          </div>
          <article class="ml-card ml-spaced ml-practice"><div class="ml-practice-head"><div><span class="ml-badge player">PRACTICE / PREDICT FIRST</span><h3>You are the policy</h3><p>Choose a racing situation, read its sensor values, and predict the controls before revealing the explanation.</p></div><label class="ml-field ml-scenario-field"><span>Situation</span><select class="ml-select" id="ml-lesson-scenario" onchange="KartBlitzMLLab.renderDecisionLesson()"><option value="straight">Open straight</option><option value="fastLeft">Fast left corner</option><option value="rightEdge">Right bend near the edge</option><option value="recovery">Off-track recovery</option></select></label></div><div class="ml-practice-grid"><div class="ml-sensor-scene" id="ml-sensor-scene"><div class="ml-road"><i id="ml-scene-kart"></i></div><div id="ml-sensor-values" class="ml-sensor-values"></div></div><div><div class="ml-choice-label">1. What should steering do?</div><div class="ml-choice-row"><button class="ml-choice" data-choice-group="steer" data-choice="left" onclick="KartBlitzMLLab.chooseLesson('steer','left')">LEFT</button><button class="ml-choice" data-choice-group="steer" data-choice="straight" onclick="KartBlitzMLLab.chooseLesson('steer','straight')">STRAIGHT</button><button class="ml-choice" data-choice-group="steer" data-choice="right" onclick="KartBlitzMLLab.chooseLesson('steer','right')">RIGHT</button></div><div class="ml-choice-label">2. What should the pedals do?</div><div class="ml-choice-row"><button class="ml-choice" data-choice-group="pedal" data-choice="throttle" onclick="KartBlitzMLLab.chooseLesson('pedal','throttle')">THROTTLE</button><button class="ml-choice" data-choice-group="pedal" data-choice="coast" onclick="KartBlitzMLLab.chooseLesson('pedal','coast')">COAST</button><button class="ml-choice" data-choice-group="pedal" data-choice="brake" onclick="KartBlitzMLLab.chooseLesson('pedal','brake')">BRAKE</button></div><button class="ml-btn primary ml-spaced" id="ml-check-decision" onclick="KartBlitzMLLab.checkDecision()" disabled>CHECK MY DECISION</button><div class="ml-coach" id="ml-decision-coach">Make both predictions. The explanation stays hidden until you commit.</div></div></div></article>
          <div class="ml-actions"><button class="ml-btn primary" onclick="KartBlitzMLLab.tab('build')">DESIGN THE OBJECTIVE &rarr;</button></div>
        </section>

        <section class="ml-panel" data-panel="build">
          <div class="ml-grid">
            <article class="ml-card"><span class="ml-badge">DO NOW / OPTIONAL IMITATION</span><h3>Give PPO a short head start</h3><div class="ml-status"><div class="ml-stat"><span>INPUTS</span><strong>24</strong></div><div class="ml-stat"><span>OUTPUTS</span><strong>3</strong></div><div class="ml-stat"><span>IMITATION</span><strong>10%</strong></div><div class="ml-stat"><span>PPO RL</span><strong>90%</strong></div></div><p>Recording is optional. Your clean laps and server-verified top-10 leaderboard ghosts replace part of the built-in teacher’s 10% example allowance; they never reduce the 90% PPO budget.</p><div class="ml-note">Choose USE FOR ML beside a verified top-10 Time Trial lap on the leaderboard. Off-track frames are excluded, and the server—not the player’s browser—must verify every imported replay.</div><label class="ml-field"><span>Demonstration circuit</span><select class="ml-select" id="ml-demo-track">${getTracks().map(track => `<option value="${Number(track.id)}">${esc(track.name)}</option>`).join('')}</select><small>Choose a circuit, press Record, and complete one clean lap. Skip this if you want leaderboard and built-in examples only.</small></label><div class="ml-actions"><button class="ml-btn primary" onclick="KartBlitzMLLab.recordHumanLap()">DO NOW: RECORD A LAP</button><button class="ml-btn" onclick="KartBlitzMLLab.exportDemonstrations()">EXPORT DEMOS</button></div><div class="ml-demo-status" id="ml-demo-status">No demonstration samples imported or recorded in this session.</div></article>
            <article class="ml-card"><span class="ml-badge player">REWARD DESIGN</span><h3>What should success mean?</h3><p>Reward is the score used during training, not the race score. Every slider changes the relative pressure on the policy.</p><div id="ml-reward-fields"></div></article>
          </div>
          <article class="ml-card ml-spaced"><span class="ml-badge player">REWARD LAB / CHANGE ONE THING</span><h3>See exactly where one frame's reward comes from</h3><p>Change the driving situation below. The coloured contributions use your reward weights above, so you can see when signals cooperate or fight each other.</p><div class="ml-reward-lab"><div class="ml-reward-scenarios"><label class="ml-param"><span>Forward movement</span><input id="ml-demo-progress" type="range" min="-1" max="3" step=".25" value="1" oninput="KartBlitzMLLab.renderRewardLab()"><small>Negative means the kart moved backwards.</small></label><label class="ml-param"><span>Speed</span><input id="ml-demo-speed" type="range" min="0" max="1" step=".05" value=".7" oninput="KartBlitzMLLab.renderRewardLab()"><small>Normalized from stopped to top speed.</small></label><label class="ml-param"><span>Track alignment</span><input id="ml-demo-alignment" type="range" min="0" max="1" step=".05" value=".9" oninput="KartBlitzMLLab.renderRewardLab()"><small>1 points along the road; 0 points sideways.</small></label><label class="ml-param"><span>Edge margin</span><input id="ml-demo-edge" type="range" min="-1" max="1" step=".05" value=".72" oninput="KartBlitzMLLab.renderRewardLab()"><small>1 is safely centred; negative is beyond an edge.</small></label><label class="ml-param"><span>Control change</span><input id="ml-demo-smooth" type="range" min="0" max="2" step=".1" value=".2" oninput="KartBlitzMLLab.renderRewardLab()"><small>Higher means a more sudden input change.</small></label><label class="ml-check"><input id="ml-demo-offtrack" type="checkbox" onchange="KartBlitzMLLab.renderRewardLab()"><span>Off track</span></label><label class="ml-check"><input id="ml-demo-stuck" type="checkbox" onchange="KartBlitzMLLab.renderRewardLab()"><span>Stuck for over 0.75 seconds</span></label><label class="ml-check"><input id="ml-demo-lap" type="checkbox" onchange="KartBlitzMLLab.renderRewardLab()"><span>Lap completed this frame</span></label></div><div><div id="ml-reward-total" class="ml-reward-total"></div><div id="ml-reward-breakdown" class="ml-reward-breakdown"></div><div class="ml-coach" id="ml-reward-coach"></div></div></div></article>
          <div class="ml-actions"><button class="ml-btn primary" onclick="KartBlitzMLLab.tab('train')">CONFIGURE TRAINING &rarr;</button></div>
        </section>

        <section class="ml-panel" data-panel="train">
          <article class="ml-card"><span class="ml-badge ok">READ THIS / TRAINING LOOP</span><h3>Training is the same five-step loop, repeated</h3><p>Click each stage to learn what it does. During a real run, ML Lab highlights the stage currently happening.</p><div class="ml-training-map" id="ml-training-map"><button data-phase="prepare" onclick="KartBlitzMLLab.explainPhase('prepare')"><b>1</b><span>PREPARE<br><small>24 sensor numbers</small></span></button><i>&rarr;</i><button data-phase="imitate" onclick="KartBlitzMLLab.explainPhase('imitate')"><b>2</b><span>IMITATE<br><small>10% warm-start</small></span></button><i>&rarr;</i><button data-phase="rollout" onclick="KartBlitzMLLab.explainPhase('rollout')"><b>3</b><span>DRIVE<br><small>90% RL experience</small></span></button><i>&rarr;</i><button data-phase="update" onclick="KartBlitzMLLab.explainPhase('update')"><b>4</b><span>UPDATE<br><small>PPO learns</small></span></button><i>&rarr;</i><button data-phase="evaluate" onclick="KartBlitzMLLab.explainPhase('evaluate')"><b>5</b><span>TEST<br><small>weights frozen</small></span></button></div><div id="ml-phase-explanation" class="ml-phase-explanation"></div></article>
          <div class="ml-grid">
            <article class="ml-card"><span class="ml-badge">DO NOW / GPU LAPTOP</span><h3>Set up and connect the Python trainer</h3><ol class="ml-do-list"><li><b>Download</b><span>Download the pack here, move it to your NVIDIA/CUDA laptop, then extract it. Do not install it on this school laptop.</span><div class="ml-actions"><button class="ml-btn primary" onclick="KartBlitzMLLab.downloadTrainerPack(this)">DOWNLOAD TRAINER PACK (.ZIP)</button><a class="ml-btn" href="ml_training/KartBlitz-ML-Setup.txt" download>DOWNLOAD SETUP GUIDE (.TXT)</a></div></li><li><b>Open PowerShell</b><span>On the GPU laptop, open the extracted KartBlitz folder. Click its address bar, type <code>powershell</code>, and press Enter.</span></li><li><b>First time only: install</b><span>Paste this whole command into that PowerShell window and press Enter.</span><div class="ml-command"><em>RUN THIS NOW</em><code id="ml-command-install">powershell -ExecutionPolicy Bypass -File .\ml_training\install.ps1</code><button type="button" onclick="KartBlitzMLLab.copyCommand('ml-command-install',this)">COPY</button></div></li><li><b>Every training session: start</b><span>Run this command and leave the PowerShell window open.</span><div class="ml-command"><em>RUN THIS NOW</em><code id="ml-command-start">powershell -ExecutionPolicy Bypass -File .\ml_training\start.ps1</code><button type="button" onclick="KartBlitzMLLab.copyCommand('ml-command-start',this)">COPY</button></div></li><li><b>Connect here</b><span>Copy the URL and pairing code printed by the trainer, paste them below, then press Connect.</span><div class="ml-actions"><input id="ml-trainer-url" class="ml-input" aria-label="Trainer URL"><input id="ml-pairing-code" class="ml-input" maxlength="12" placeholder="PAIRING CODE" aria-label="Pairing code"><button class="ml-btn" onclick="KartBlitzMLLab.connect()">DO NOW: CONNECT</button></div></li></ol><div id="ml-connect-note" class="ml-note">CUDA accelerates neural-network updates. The parallel race simulations run on CPU, so both CPU and GPU performance matter.</div></article>
            <article class="ml-card"><span class="ml-badge player">DO NOW / IN KARTBLITZ</span><h3>Choose the experiment budget</h3><label class="ml-field"><span>Training preset</span><select class="ml-select" id="ml-preset" onchange="KartBlitzMLLab.applyPreset()"><option value="lesson">Lesson / 300k total steps</option><option value="competitive" selected>Competitive / 3m total steps</option><option value="endurance">Endurance / 10m total steps</option></select><small>Every preset reserves exactly 10% for imitation and 90% for PPO reinforcement learning. More steps create more chances to improve, but evaluation decides whether it actually did.</small></label><div class="ml-run-explain" id="ml-run-explain"></div><div class="ml-actions"><button id="ml-start-btn" class="ml-btn primary" onclick="KartBlitzMLLab.startTraining()">DO NOW: START 90% PPO TRAINING</button><button class="ml-btn" onclick="KartBlitzMLLab.exportConfig()">EXPORT JOB INSTEAD</button></div><div class="ml-progress"><i id="ml-progress-bar"></i></div><div class="ml-status"><div class="ml-stat"><span>PHASE</span><strong id="ml-job-status">READY</strong></div><div class="ml-stat"><span>STEP</span><strong id="ml-job-step">0</strong></div><div class="ml-stat"><span>REWARD</span><strong id="ml-job-reward">-</strong></div><div class="ml-stat"><span>DEVICE</span><strong id="ml-job-device">-</strong></div></div><div class="ml-console" id="ml-console">Waiting for a training run...</div></article>
          </div>
          <article class="ml-card ml-spaced"><span class="ml-badge">READ THIS / OPTIONAL ADVANCED</span><h3>How PPO updates the driver</h3><p>You do not need to change these for your first run. Each description explains what increasing or decreasing the value changes.</p><div id="ml-parameter-fields" class="ml-parameter-grid"></div><div class="ml-note">For later experiments, change only one or two values at a time and keep exported results. Otherwise you cannot tell which change helped.</div></article>
        </section>

        <section class="ml-panel" data-panel="replay">
          <article class="ml-card"><span class="ml-badge">REAL CHECKPOINT REPLAY</span><h3>Watch measured trajectories, not a scripted animation</h3><p>Warm-start, halfway and final paths are captured by running the actual neural policy in the training environment. Red path segments indicate off-track samples.</p><div class="ml-canvas-wrap"><canvas id="ml-replay-canvas" width="1000" height="420"></canvas><div class="ml-canvas-label" id="ml-replay-label">NO CHECKPOINT DATA</div></div><div class="ml-actions ml-spaced"><button class="ml-btn" onclick="KartBlitzMLLab.replayTrack(-1)">&larr; TRACK</button><button class="ml-btn" onclick="KartBlitzMLLab.replayTrack(1)">TRACK &rarr;</button></div></article>
          <article class="ml-card ml-spaced"><span class="ml-badge ok">EVALUATION</span><h3>Does it finish consistently and quickly?</h3><div id="ml-evaluation"></div></article>
        </section>

        <section class="ml-panel" data-panel="race">
          <div class="ml-grid"><article class="ml-card" id="ml-model-ours"><span class="ml-badge">OUR MODEL</span><h3 id="ml-ours-name">KartBlitz Pre-Tuned Driver</h3><p>The game's existing hand-tuned driver: a dependable reference, not a learned policy.</p><button class="ml-btn primary" onclick="KartBlitzMLLab.selectModel('ours')">SELECT OUR MODEL</button></article><article class="ml-card" id="ml-model-player"><span class="ml-badge player">YOUR MODEL</span><h3 id="ml-player-name">No trained weights</h3><p id="ml-player-copy">Train on the Python companion or import a .kartml.json file.</p><div class="ml-actions"><button id="ml-select-player" class="ml-btn pink" onclick="KartBlitzMLLab.selectModel('player')">SELECT YOUR MODEL</button><button class="ml-btn" onclick="document.getElementById('ml-import-file').click()">IMPORT</button><button id="ml-export-model" class="ml-btn" onclick="KartBlitzMLLab.exportModel()">EXPORT</button><input hidden id="ml-import-file" type="file" accept=".json,.kartml.json"></div></article></div>
          <article class="ml-card ml-spaced"><span class="ml-badge ok">RACE SETUP</span><h3>Choose a circuit</h3><div class="ml-track-grid" id="ml-track-grid"></div><div class="ml-actions"><button class="ml-btn primary" onclick="KartBlitzMLLab.launchRace()">RACE SELECTED MODEL</button></div><div class="ml-note">ML Lab has exactly two opponent choices: Our Model or Your Model. No hidden official agent is substituted.</div></article>
        </section>
      </main>`;
  }

  function installScreen() {
    if (!document.getElementById('ml-lab-menu-btn')) {
      const actions = document.querySelector('#screen-menu .menu-actions');
      const button = document.createElement('button');
      button.type = 'button'; button.id = 'ml-lab-menu-btn'; button.className = 'btn btn-sm'; button.style.color = '#67e8f9'; button.textContent = ' ML LAB';
      button.onclick = () => { if (typeof initAudio === 'function') initAudio(); if (typeof playUIClick === 'function') playUIClick(); open(); };
      if (actions) actions.insertBefore(button, actions.lastElementChild);
    }
    if (document.getElementById('screen-ml-lab')) return;
    const screen = document.createElement('div');
    screen.id = 'screen-ml-lab'; screen.className = 'screen hidden'; screen.innerHTML = screenMarkup(); document.body.appendChild(screen);
    document.getElementById('ml-import-file').addEventListener('change', importModel);
    document.getElementById('ml-trainer-url').value = state.trainerUrl;
    document.getElementById('ml-pairing-code').value = state.pairingCode;
    renderRewards(); renderParameters(); renderDecisionLesson(); renderRewardLab(); explainPhase('prepare'); updateTrainingExplanation(); renderRace(); renderEvaluation(); updateDemoStatus(); updateVisibility(); loadTracks();
  }

  function renderRewards() {
    const host = document.getElementById('ml-reward-fields'); if (!host) return;
    host.innerHTML = rewardDefs.map(([id, label, value, min, max, description]) => `<div class="ml-field"><label for="ml-r-${id}"><span>${label}</span><b id="ml-rv-${id}">${value.toFixed(2)}</b></label><input id="ml-r-${id}" type="range" min="${min}" max="${max}" step="0.05" value="${value}" oninput="document.getElementById('ml-rv-${id}').textContent=Number(this.value).toFixed(2);KartBlitzMLLab.renderRewardLab()"><small>${description}</small></div>`).join('');
  }
  function renderParameters() {
    const host = document.getElementById('ml-parameter-fields'); if (!host) return;
    host.innerHTML = parameterDefs.map(([id, label, value, min, max, step, description]) => `<label class="ml-param" for="ml-p-${id}"><span>${label}</span><input id="ml-p-${id}" class="ml-input" type="number" value="${value}" min="${min}" max="${max}" step="${step}" oninput="KartBlitzMLLab.updateTrainingExplanation()"><small>${description}</small></label>`).join('');
  }
  function rewards() { return Object.fromEntries(rewardDefs.map(([id]) => [id, Number(document.getElementById(`ml-r-${id}`).value)])); }
  function parameters() { return Object.fromEntries(parameterDefs.map(([id, , fallback]) => { const value = Number(document.getElementById(`ml-p-${id}`).value); return [id, Number.isFinite(value) ? value : fallback]; })); }

  function scoreDecision(scenarioKey, choices) {
    const scenario = lessonScenarios[scenarioKey] || lessonScenarios.straight;
    return { scenario, score: Number(choices.steer === scenario.steer) + Number(choices.pedal === scenario.pedal), steerCorrect: choices.steer === scenario.steer, pedalCorrect: choices.pedal === scenario.pedal };
  }

  function calculateRewardFrame(weights, frame) {
    const edge = frame.offTrack ? 0 : (Number.isFinite(frame.edge) ? frame.edge : .72);
    const parts = [
      ['Progress', weights.progress * frame.progress * 2.8],
      ['Useful speed', weights.speed * frame.speed * frame.alignment * (frame.offTrack ? 0 : 1) * .025],
      ['Track position', weights.line * Math.max(0, edge) * .0125],
      ['Heading', weights.heading * frame.alignment * .01],
      ['Off-track', -weights.offTrack * Number(!!frame.offTrack) * .0275],
      ['Smooth controls', -weights.smoothness * frame.smooth * .0125],
      ['Stuck', -weights.stuck * Number(!!frame.stuck) * .03],
      ['Lap bonus', weights.lap * Number(!!frame.lap)]
    ];
    return { parts, total: parts.reduce((sum, part) => sum + part[1], 0) };
  }

  function renderDecisionLesson() {
    const select = document.getElementById('ml-lesson-scenario'); if (!select) return;
    const scenario = lessonScenarios[select.value] || lessonScenarios.straight;
    state.lessonChoices = { steer: null, pedal: null }; state.lessonChecked = false;
    document.querySelectorAll('[data-choice-group]').forEach(button => button.classList.remove('selected', 'correct', 'wrong'));
    const check = document.getElementById('ml-check-decision'); if (check) check.disabled = true;
    const kart = document.getElementById('ml-scene-kart');
    if (kart) { kart.style.left = `${50 + scenario.lateral * 23}%`; kart.style.transform = `translate(-50%,-50%) rotate(${scenario.curve * 20}deg)`; kart.classList.toggle('offtrack', scenario.offTrack); }
    const values = document.getElementById('ml-sensor-values');
    if (values) values.innerHTML = [['SPEED', scenario.speed, scenario.speed.toFixed(2)], ['SIDE OFFSET', Math.abs(scenario.lateral) / 1.3, `${scenario.lateral > 0 ? '+' : ''}${scenario.lateral.toFixed(2)}`], ['UPCOMING CURVE', Math.abs(scenario.curve), `${scenario.curve < 0 ? 'LEFT ' : scenario.curve > 0 ? 'RIGHT ' : ''}${Math.abs(scenario.curve).toFixed(2)}`], ['GRIP', scenario.grip, scenario.grip.toFixed(2)]].map(([name, amount, text]) => `<div><span>${name}<b>${text}</b></span><i><em style="width:${Math.min(100, amount * 100)}%"></em></i></div>`).join('');
    const coach = document.getElementById('ml-decision-coach'); if (coach) { coach.className = 'ml-coach'; coach.textContent = 'Make both predictions. The explanation stays hidden until you commit.'; }
  }

  function chooseLesson(group, choice) {
    if (!['steer', 'pedal'].includes(group) || state.lessonChecked) return;
    state.lessonChoices[group] = choice;
    document.querySelectorAll(`[data-choice-group="${group}"]`).forEach(button => button.classList.toggle('selected', button.dataset.choice === choice));
    const check = document.getElementById('ml-check-decision'); if (check) check.disabled = !(state.lessonChoices.steer && state.lessonChoices.pedal);
  }

  function checkDecision() {
    const select = document.getElementById('ml-lesson-scenario'); if (!select || !state.lessonChoices.steer || !state.lessonChoices.pedal) return;
    const result = scoreDecision(select.value, state.lessonChoices), scenario = result.scenario; state.lessonChecked = true;
    ['steer', 'pedal'].forEach(group => document.querySelectorAll(`[data-choice-group="${group}"]`).forEach(button => {
      const isAnswer = button.dataset.choice === scenario[group], wasChosen = button.dataset.choice === state.lessonChoices[group];
      button.classList.toggle('correct', isAnswer); button.classList.toggle('wrong', wasChosen && !isAnswer);
    }));
    const score = result.score;
    const directionReason = scenario.offTrack ? `The offset is ${scenario.lateral.toFixed(2)}, so steering ${scenario.steer} points back toward the road.` : Math.abs(scenario.curve) < .1 ? 'The look-ahead curve is almost zero, so large steering would only add instability.' : `The ${scenario.curve < 0 ? 'negative' : 'positive'} curve sensor predicts a ${scenario.steer} turn.`;
    const pedalReason = scenario.pedal === 'brake' ? `Speed ${scenario.speed.toFixed(2)} is well above the safe target ${scenario.target.toFixed(2)}, so braking before turn-in creates grip.` : scenario.pedal === 'coast' ? `${scenario.offTrack ? 'Low grip makes full throttle likely to widen the recovery.' : 'Speed is close to the corner target, so coasting preserves balance.'}` : `Speed ${scenario.speed.toFixed(2)} is below the safe target ${scenario.target.toFixed(2)} and the road is open.`;
    const coach = document.getElementById('ml-decision-coach'); if (coach) { coach.className = `ml-coach ${score === 2 ? 'success' : 'review'}`; coach.innerHTML = `<strong>${score}/2 matched the safe teacher.</strong><span>${directionReason} ${pedalReason}</span><small>This teacher is only a starting example. PPO may discover a faster continuous control after experimentation.</small>`; }
  }

  function renderRewardLab() {
    const totalElement = document.getElementById('ml-reward-total'); if (!totalElement || !document.getElementById('ml-r-progress')) return;
    const weights = rewards(), readNumber = id => Number(document.getElementById(id).value);
    const progress = readNumber('ml-demo-progress'), speed = readNumber('ml-demo-speed'), alignment = readNumber('ml-demo-alignment'), edge = readNumber('ml-demo-edge'), smooth = readNumber('ml-demo-smooth');
    const offTrack = document.getElementById('ml-demo-offtrack').checked, stuck = document.getElementById('ml-demo-stuck').checked, lap = document.getElementById('ml-demo-lap').checked;
    const calculation = calculateRewardFrame(weights, { progress, speed, alignment, edge, smooth, offTrack, stuck, lap }), parts = calculation.parts, total = calculation.total, maxMagnitude = Math.max(.001, ...parts.map(part => Math.abs(part[1])));
    totalElement.className = `ml-reward-total ${total < 0 ? 'negative' : ''}`; totalElement.innerHTML = `<span>REWARD THIS FRAME</span><strong>${total >= 0 ? '+' : ''}${total.toFixed(3)}</strong>`;
    document.getElementById('ml-reward-breakdown').innerHTML = parts.map(([name, value]) => `<div><span>${name}</span><i class="${value < 0 ? 'negative' : ''}"><em style="width:${Math.max(2, Math.abs(value) / maxMagnitude * 100)}%"></em></i><b>${value >= 0 ? '+' : ''}${value.toFixed(3)}</b></div>`).join('');
    const dominant = parts.reduce((best, part) => Math.abs(part[1]) > Math.abs(best[1]) ? part : best, parts[0]);
    const coach = document.getElementById('ml-reward-coach'); coach.innerHTML = `<strong>What the policy learns:</strong><span>${dominant[0]} dominates this frame. ${lap ? 'Notice how the rare lap bonus is large, while dense progress gives guidance on every frame.' : offTrack ? 'Speed pays nothing off track, while the off-track cost pushes the policy to recover.' : 'Try checking Off track or Lap completed, then compare the scale of every bar.'}</span>`;
  }

  function explainPhase(phase) {
    const lesson = phaseLessons[phase] || phaseLessons.prepare, host = document.getElementById('ml-phase-explanation'); if (!host) return;
    document.querySelectorAll('#ml-training-map [data-phase]').forEach(button => button.classList.toggle('active', button.dataset.phase === phase));
    host.innerHTML = `<h4>${lesson.title}</h4><p>${lesson.plain}</p><div><span><b>WATCH FOR</b>${lesson.watch}</span><span><b>COMMON TRAP</b>${lesson.trap}</span></div>`;
  }

  function updateTrainingExplanation() {
    const host = document.getElementById('ml-run-explain'); if (!host || !document.getElementById('ml-p-numEnvs')) return;
    const preset = document.getElementById('ml-preset').value, total = { lesson: 300000, competitive: 3000000, endurance: 10000000 }[preset], imitation = Math.round(total * .10), reinforcement = total - imitation, settings = parameters(), batch = settings.numEnvs * settings.horizon, loops = Math.ceil(reinforcement / Math.max(1, batch));
    host.innerHTML = `<strong>Exactly where the budget goes</strong><div class="ml-balance compact" aria-label="${imitation.toLocaleString()} imitation samples and ${reinforcement.toLocaleString()} reinforcement learning steps"><span style="width:10%">10% IL</span><strong style="width:90%">90% PPO RL</strong></div><span><b>${imitation.toLocaleString()}</b> imitation samples teach a safe starting behaviour. Then imitation stops. The policy learns mainly by trial, reward and PPO for <b>${reinforcement.toLocaleString()}</b> reinforcement-learning steps.</span><span><b>${settings.numEnvs}</b> simulated karts collect <b>${settings.horizon}</b> frames each: ${batch.toLocaleString()} RL experiences before each PPO update, repeated about <b>${loops.toLocaleString()}</b> times.</span><small>Simulation collection is CPU work. CUDA accelerates actor/critic updates between collections.</small>`;
  }

  function applyPreset() {
    const preset = document.getElementById('ml-preset').value;
    const values = { lesson: { numEnvs: 16, horizon: 128, imitationEpochs: 2 }, competitive: { numEnvs: 48, horizon: 256, imitationEpochs: 3 }, endurance: { numEnvs: 80, horizon: 256, imitationEpochs: 4 } }[preset];
    Object.entries(values).forEach(([key, value]) => { const field = document.getElementById(`ml-p-${key}`); if (field) field.value = value; });
    updateTrainingExplanation();
  }

  function settingsMarkup() {
    return `<div class="howto-section" style="width:min(560px,94vw);"><div class="howto-heading"> ML LAB</div><div class="ml-settings-row"><p>Show the optional machine-learning course, trainer and model-racing tools on the main menu.</p><button type="button" class="key-btn ml-toggle${state.enabled ? ' key-btn-active' : ''}" onclick="KartBlitzMLLab.setEnabled(${!state.enabled});playUIClick();buildSettingsPane();" aria-pressed="${state.enabled}">ML LAB: ${state.enabled ? 'ON' : 'OFF'}</button></div></div>`;
  }
  function hookSettings() {
    if (window.__kartblitzMLSettingsHooked || typeof window.buildSettingsPane !== 'function') return;
    window.__kartblitzMLSettingsHooked = true;
    const original = window.buildSettingsPane;
    window.buildSettingsPane = function () { const result = original.apply(this, arguments); const pane = document.getElementById('ctrl-pane-settings'); if (pane && !pane.querySelector('.ml-settings-row')) pane.insertAdjacentHTML('beforeend', settingsMarkup()); return result; };
  }
  function setEnabled(value) { state.enabled = !!value; write(ENABLE_KEY, state.enabled ? '1' : '0'); updateVisibility(); }
  function updateVisibility() { const button = document.getElementById('ml-lab-menu-btn'); if (button) button.hidden = !state.enabled; }
  function open() { if (state.enabled && typeof showScreen === 'function') { showScreen('ml-lab'); tab('learn'); } }
  function close() { stopReplay(); if (typeof showScreen === 'function') showScreen('menu'); }
  function tab(name) {
    document.querySelectorAll('#screen-ml-lab .ml-tab').forEach(item => item.classList.toggle('active', item.dataset.tab === name));
    document.querySelectorAll('#screen-ml-lab .ml-panel').forEach(item => item.classList.toggle('active', item.dataset.panel === name));
    if (name === 'replay') startReplay(); else stopReplay();
    if (name === 'race') renderRace();
  }

  async function loadTracks() {
    try {
      const response = await fetch('sim/tracks/bakes.json'); const payload = await response.json(); const raw = payload.tracks || payload;
      state.tracks = Array.isArray(raw) ? raw : Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map(key => raw[key]);
    } catch (_) { state.tracks = null; }
  }
  async function loadOurModel() {
    try { const response = await fetch('ml/models/our-model.json'); const model = await response.json(); Runtime.validateModel(model); state.ourModel = model; }
    catch (_) { state.ourModel = Runtime.DEFAULT_MODEL; }
    renderRace();
  }

  function trainingConfig() {
    const preset = document.getElementById('ml-preset').value;
    const totalSteps = { lesson: 300000, competitive: 3000000, endurance: 10000000 }[preset];
    return { format: 'kartblitz-training-job-v1', contractVersion: 2, preset, totalSteps, imitationShare: .10, reinforcementShare: .90, ...parameters(), epochs: 6, minibatch: 2048, tracks: 'all', rewards: rewards(), demonstrations: state.demonstrations, seed: 42 };
  }
  async function connect() {
    state.trainerUrl = document.getElementById('ml-trainer-url').value.trim().replace(/\/$/, ''); state.pairingCode = document.getElementById('ml-pairing-code').value.trim();
    write(TRAINER_URL_KEY, state.trainerUrl); write(TRAINER_CODE_KEY, state.pairingCode);
    const note = document.getElementById('ml-connect-note');
    try {
      const response = await fetch(`${state.trainerUrl}/api/status`, { signal: AbortSignal.timeout(3500) }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.trainer = await response.json(); const cuda = state.trainer.cudaAvailable;
      note.textContent = state.trainer.torchInstalled ? `${state.trainer.torchVersion} ready / ${cuda ? state.trainer.deviceName : 'CPU only'} / ${state.trainer.trackCount} tracks / trainer API v${state.trainer.apiVersion}` : 'PyTorch is not installed on the trainer computer. Run the included install script there.';
      const badge = document.getElementById('ml-device-badge'); badge.textContent = cuda ? 'CUDA READY' : (state.trainer.torchInstalled ? 'CPU READY' : 'PYTORCH MISSING'); badge.className = `ml-badge ${state.trainer.torchInstalled ? 'ok' : 'warn'}`;
    } catch (error) { state.trainer = null; note.textContent = `Could not reach the local trainer: ${error.message}`; }
  }
  async function startTraining() {
    if (!state.trainer) await connect();
    if (!state.trainer || !state.trainer.torchInstalled) { log('Connect to a trainer with PyTorch before starting.'); return; }
    const button = document.getElementById('ml-start-btn'); button.disabled = true;
    try {
      const response = await fetch(`${state.trainerUrl}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KartBlitz-Key': state.pairingCode }, body: JSON.stringify(trainingConfig()) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`); state.job = payload; pollJob();
    } catch (error) { log(`Training could not start: ${error.message}`); button.disabled = false; }
  }
  async function pollJob() {
    clearTimeout(state.pollTimer); if (!state.job) return;
    try {
      const response = await fetch(`${state.trainerUrl}/api/jobs/${encodeURIComponent(state.job.id)}`, { headers: { 'X-KartBlitz-Key': state.pairingCode } });
      const job = await response.json(); if (!response.ok) throw new Error(job.error || `HTTP ${response.status}`); state.job = job; updateJob(job);
      if (job.status === 'complete') {
        Runtime.validateModel(job.model); state.playerModel = job.model; state.snapshots = job.snapshots || (job.model.training && job.model.training.replay) || []; write(PLAYER_MODEL_KEY, JSON.stringify(job.model));
        document.getElementById('ml-start-btn').disabled = false; renderRace(); renderEvaluation(); tab('replay'); return;
      }
      if (job.status === 'failed') { document.getElementById('ml-start-btn').disabled = false; return; }
      state.pollTimer = setTimeout(pollJob, 900);
    } catch (error) { log(`Trainer connection interrupted: ${error.message}`); state.pollTimer = setTimeout(pollJob, 2500); }
  }
  function updateJob(job) {
    const progress = Math.round(100 * (job.step || 0) / Math.max(1, job.totalSteps || 1));
    document.getElementById('ml-progress-bar').style.width = `${progress}%`;
    document.getElementById('ml-job-status').textContent = String(job.phase || job.status || 'running').toUpperCase();
    document.getElementById('ml-job-step').textContent = Number(job.step || 0).toLocaleString();
    document.getElementById('ml-job-reward').textContent = Number.isFinite(job.meanReward) ? job.meanReward.toFixed(3) : '-';
    document.getElementById('ml-job-device').textContent = job.device || '-'; log((job.logs || []).slice(-10).join('\n') || `Training ${progress}% complete...`, true);
    if (job.status === 'complete' || job.phase === 'evaluation') explainPhase('evaluate');
    else if (job.phase === 'prepare') explainPhase('prepare');
    else if (job.phase === 'imitation') explainPhase('imitate');
    else if (job.phase === 'rollout') explainPhase('rollout');
    else if (job.phase === 'ppo') explainPhase('update');
  }
  function log(message, replace) { const element = document.getElementById('ml-console'); if (!element) return; element.textContent = replace ? message : `${element.textContent}\n${message}`; element.scrollTop = element.scrollHeight; }

  function beginRecording() {
    state.recording = { trackId: state.selectedTrack, started: false, samples: [], sensorState: {}, accumulator: 0, recordedAt: Date.now() };
    updateDemoStatus();
  }
  function recordHumanLap() {
    const trackField = document.getElementById('ml-demo-track');
    if (trackField) state.selectedTrack = Number(trackField.value) || 0;
    beginRecording();
    const playerData = typeof getPlayerData === 'function' ? getPlayerData() : null;
    if (playerData) { playerData.selectedLaps = 1; if (typeof savePlayerData === 'function') savePlayerData(playerData); }
    if (typeof window.startMLLabRace === 'function') window.startMLLabRace(state.selectedTrack, { modelType: 'ours', model: state.ourModel, trackId: state.selectedTrack, recordingHuman: true });
  }
  function captureRaceFrame(race, elapsed, input) {
    const recording = state.recording; if (!recording || !race || !race.karts || !race.karts[0]) return;
    const kart = race.karts[0];
    if (race.phase === 'racing' && !kart.finished) {
      recording.started = true; recording.accumulator += Math.max(0, Number(elapsed) || 0);
      if (recording.accumulator < 1 / 15) return;
      recording.accumulator %= 1 / 15;
      const observation = Runtime.observeV2(kart, race.track, recording.sensorState);
      const steer = Number.isFinite(input && input.steer) ? input.steer : ((input && input.right ? 1 : 0) - (input && input.left ? 1 : 0));
      const throttle = Number.isFinite(input && input.throttle) ? input.throttle : (input && input.up ? 1 : 0);
      const brake = Number.isFinite(input && input.brake) ? input.brake : (input && input.down ? 1 : 0);
      recording.samples.push({ observation: observation.map(value => Math.round(value * 100000) / 100000), action: [steer, throttle * 2 - 1, brake * 2 - 1].map(value => Math.round(Math.max(-1, Math.min(1, value)) * 100000) / 100000) });
      recording.sensorState.previousSteer = steer;
      recording.sensorState.previousThrottle = throttle;
      recording.sensorState.previousBrake = brake;
    }
    if (recording.started && (kart.finished || race.phase === 'finished')) finishRecording(kart.finished);
  }
  function finishRecording(finished) {
    const recording = state.recording; if (!recording) return;
    state.recording = null;
    if (recording.samples.length >= 30) state.demonstrations.push({ format: 'kartblitz-demonstration-v1', observationVersion: 2, trackId: recording.trackId, completedLap: !!finished, recordedAt: recording.recordedAt, sampleRateHz: 15, samples: recording.samples });
    updateDemoStatus();
  }
  function updateDemoStatus() {
    const element = document.getElementById('ml-demo-status'); if (!element) return;
    if (state.recording) { element.textContent = `Recording track ${state.recording.trackId + 1}: drive one clean lap. ${state.recording.samples.length.toLocaleString()} samples captured.`; return; }
    const count = state.demonstrations.reduce((sum, demo) => sum + demo.samples.length, 0);
    const leaderboardCount = state.demonstrations.filter(demo => demo.source === 'verified-top-10').length;
    element.textContent = count ? `${state.demonstrations.length} demonstration run(s), ${count.toLocaleString()} samples${leaderboardCount ? `, including ${leaderboardCount} verified top-10 ghost${leaderboardCount === 1 ? '' : 's'}` : ''}. They will be included in the next job.` : 'No demonstration samples imported or recorded in this session.';
  }

  async function importLeaderboardGhost(payload) {
    const ghostApi = window.KartBlitzGhost;
    const unpacked = payload && (payload.unpacked || (ghostApi && ghostApi.unpackLeaderboardGhost(payload.ghost)));
    const rank = Number(payload && payload.rank);
    if (!unpacked || !(rank >= 1 && rank <= 10)) throw new Error('Only a current verified top-10 ghost can be imported.');
    if (!state.tracks) await loadTracks();
    const track = state.tracks && state.tracks.find(item => Number(item.id) === Number(unpacked.trackId));
    if (!track) throw new Error('The ghost track is not available in ML Lab.');
    const sourceId = String(payload.runId || `${payload.username}-${unpacked.trackId}-${unpacked.lapTime}`);
    state.demonstrations = state.demonstrations.filter(demo => demo.sourceId !== sourceId);
    const sensorState = {}, samples = [], maxSpeed = Math.max(1, Number(unpacked.packed.maxSpeed) || 362);
    for (const frame of unpacked.samples) {
      const flags = frame.flags & 0xff;
      const steer = (flags & 4) && !(flags & 8) ? -1 : (flags & 8) && !(flags & 4) ? 1 : 0;
      const throttle = flags & 1 ? 1 : 0, brake = flags & 2 ? 1 : 0;
      const kart = { x: frame.x, y: frame.y, angle: frame.a, speed: frame.speed, maxSpeed, isOffTrack: frame.offTrack, ersCharge: frame.ersCharge, drsAvailable: true, drsInZone: frame.drsInZone, grip: frame.grip };
      const observation = Runtime.observeV2(kart, track, sensorState);
      if (!frame.offTrack) samples.push({ observation: observation.map(value => Math.round(value * 100000) / 100000), action: [steer, throttle * 2 - 1, brake * 2 - 1] });
      sensorState.previousSteer = steer; sensorState.previousThrottle = throttle; sensorState.previousBrake = brake;
    }
    if (samples.length < 30) throw new Error('The verified ghost does not contain enough clean samples.');
    state.demonstrations.push({ format: 'kartblitz-demonstration-v1', observationVersion: 2, source: 'verified-top-10', sourceId, username: String(payload.username || 'TOP 10'), rank, trackId: unpacked.trackId, lapTime: unpacked.lapTime, completedLap: true, sampleRateHz: 15, samples });
    setEnabled(true); open(); tab('build'); updateDemoStatus();
    const status = document.getElementById('ml-demo-status'); if (status) status.classList.add('success');
  }

  function download(name, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyCommand(id, button) {
    const command = document.getElementById(id)?.textContent?.trim(); if (!command) return;
    const original = button ? button.textContent : '';
    try {
      await navigator.clipboard.writeText(command);
      if (button) { button.textContent = 'COPIED'; button.classList.add('copied'); setTimeout(() => { button.textContent = original; button.classList.remove('copied'); }, 1600); }
    } catch (_) {
      window.prompt('Copy this command:', command);
    }
  }
  function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
  function zipChunk(size) { return new Uint8Array(size); }
  function set16(bytes, offset, value) { new DataView(bytes.buffer).setUint16(offset, value, true); }
  function set32(bytes, offset, value) { new DataView(bytes.buffer).setUint32(offset, value >>> 0, true); }
  function makeZip(files) {
    const encoder = new TextEncoder(), locals = [], centrals = []; let offset = 0;
    files.forEach(file => {
      const name = encoder.encode(file.path.replace(/\\/g, '/')), data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data, checksum = crc32(data);
      const local = zipChunk(30 + name.length + data.length); set32(local, 0, 0x04034b50); set16(local, 4, 20); set16(local, 6, 0x0800); set32(local, 14, checksum); set32(local, 18, data.length); set32(local, 22, data.length); set16(local, 26, name.length); local.set(name, 30); local.set(data, 30 + name.length); locals.push(local);
      const central = zipChunk(46 + name.length); set32(central, 0, 0x02014b50); set16(central, 4, 20); set16(central, 6, 20); set16(central, 8, 0x0800); set32(central, 16, checksum); set32(central, 20, data.length); set32(central, 24, data.length); set16(central, 28, name.length); set32(central, 42, offset); central.set(name, 46); centrals.push(central); offset += local.length;
    });
    const centralSize = centrals.reduce((sum, item) => sum + item.length, 0), end = zipChunk(22); set32(end, 0, 0x06054b50); set16(end, 8, files.length); set16(end, 10, files.length); set32(end, 12, centralSize); set32(end, 16, offset); return new Blob([...locals, ...centrals, end], { type: 'application/zip' });
  }
  async function downloadTrainerPack(button) {
    if (button) { button.disabled = true; button.textContent = 'BUILDING ZIP...'; }
    const paths = ['ml_training/__init__.py', 'ml_training/environment.py', 'ml_training/model.py', 'ml_training/train.py', 'ml_training/server.py', 'ml_training/requirements.txt', 'ml_training/install.ps1', 'ml_training/start.ps1', 'ml_training/README.md', 'ml_training/KartBlitz-ML-Setup.txt', 'sim/tracks/bakes.json'];
    try {
      const files = await Promise.all(paths.map(async path => { const response = await fetch(path); if (!response.ok) throw new Error(`Could not fetch ${path}`); return { path, data: new Uint8Array(await response.arrayBuffer()) }; }));
      const blob = makeZip(files), url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'KartBlitz-ML-Trainer.zip'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (error) { alert(`Trainer pack download failed: ${error.message}`); }
    finally { if (button) { button.disabled = false; button.textContent = 'DOWNLOAD TRAINER PACK (.ZIP)'; } }
  }
  function exportConfig() { download('kartblitz-training-job.json', trainingConfig()); }
  function exportDemonstrations() { if (state.demonstrations.length) download('kartblitz-human-demonstrations.json', { format: 'kartblitz-demonstration-bundle-v1', demonstrations: state.demonstrations }); }
  function exportModel() { if (state.playerModel) download(`${state.playerModel.id || 'your-kartblitz-model'}.kartml.json`, state.playerModel); }
  async function importModel(event) {
    const file = event.target.files && event.target.files[0]; if (!file) return;
    try {
      const model = JSON.parse(await file.text()); Runtime.validateModel(model); model.source = 'player'; state.playerModel = model; state.snapshots = model.training && Array.isArray(model.training.replay) ? model.training.replay : []; write(PLAYER_MODEL_KEY, JSON.stringify(model)); renderRace(); renderEvaluation();
    } catch (error) { alert(`Could not import model: ${error.message}`); }
    event.target.value = '';
  }

  function selectModel(which) { if (which === 'player' && !state.playerModel) return; state.selectedModel = which; renderRace(); }
  function selectTrack(id) { state.selectedTrack = Number(id) || 0; renderRace(); }
  function renderRace() {
    const ours = document.getElementById('ml-model-ours'); if (!ours) return;
    ours.classList.toggle('selected', state.selectedModel === 'ours'); document.getElementById('ml-model-player').classList.toggle('selected', state.selectedModel === 'player');
    document.getElementById('ml-player-name').textContent = state.playerModel ? state.playerModel.name : 'No trained weights';
    const training = state.playerModel && state.playerModel.training, evaluation = state.playerModel && state.playerModel.evaluation;
    document.getElementById('ml-player-copy').textContent = state.playerModel ? `${training && training.algorithm || 'Policy'} / ${(training && training.totalSteps || 0).toLocaleString()} steps / ${evaluation && evaluation.status || 'not evaluated'}` : 'Train on the Python companion or import a .kartml.json file.';
    document.getElementById('ml-select-player').disabled = !state.playerModel; document.getElementById('ml-export-model').disabled = !state.playerModel;
    document.getElementById('ml-track-grid').innerHTML = getTracks().map(track => `<button class="ml-track${Number(track.id) === state.selectedTrack ? ' selected' : ''}" onclick="KartBlitzMLLab.selectTrack(${Number(track.id)})">${esc(track.name)}</button>`).join('');
  }
  function launchRace() {
    const model = state.selectedModel === 'player' ? state.playerModel : state.ourModel; if (!model) return; Runtime.validateModel(model);
    const playerData = typeof getPlayerData === 'function' ? getPlayerData() : null; if (playerData) { playerData.selectedLaps = 3; if (typeof savePlayerData === 'function') savePlayerData(playerData); }
    if (typeof window.startMLLabRace === 'function') window.startMLLabRace(state.selectedTrack, { modelType: state.selectedModel, model, trackId: state.selectedTrack });
  }

  function renderEvaluation() {
    const host = document.getElementById('ml-evaluation'); if (!host) return;
    const evaluation = state.playerModel && state.playerModel.evaluation, rows = evaluation && evaluation.perTrack;
    if (!Array.isArray(rows) || !rows.length) { host.innerHTML = '<div class="ml-empty">No evaluation report is loaded. Train or import a v2 model to see per-track evidence.</div>'; return; }
    host.innerHTML = `<div class="ml-eval-summary"><b>${esc(evaluation.status)}</b><span>${Math.round((evaluation.simulatedFinishRate || 0) * 100)}% simulated finishes</span><span>${((evaluation.simulatedOffTrackRate || 0) * 100).toFixed(1)}% off-track</span></div><div class="ml-table-wrap"><table class="ml-table"><thead><tr><th>Track</th><th>Finish</th><th>Median lap</th><th>Mean speed</th><th>Off-track</th><th>Recovery fail</th></tr></thead><tbody>${rows.map(row => `<tr><td>${Number(row.trackId) + 1}</td><td>${Math.round(row.finishRate * 100)}%</td><td>${row.medianLapTime == null ? '-' : `${row.medianLapTime.toFixed(2)}s`}</td><td>${Number(row.meanSpeed).toFixed(0)}</td><td>${(row.offTrackRate * 100).toFixed(1)}%</td><td>${Math.round(row.recoveryFailureRate * 100)}%</td></tr>`).join('')}</tbody></table></div><div class="ml-note">Human-level status is deliberately not awarded by the lightweight simulator. Race the model in KartBlitz and compare several median laps.</div>`;
  }

  function replayTrack(delta) { const count = Math.max(1, (state.tracks || getTracks()).length); state.selectedTrack = (state.selectedTrack + delta + count) % count; state.frame = 0; startReplay(); }
  function startReplay() { stopReplay(); state.frame = 0; drawReplay(); }
  function stopReplay() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0; }
  function drawTrack(ctx, canvas, track) {
    const points = track.spline, xs = points.map(point => point.x), ys = points.map(point => point.y), minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min((canvas.width - 90) / Math.max(1, maxX - minX), (canvas.height - 70) / Math.max(1, maxY - minY)), offsetX = (canvas.width - (maxX - minX) * scale) / 2, offsetY = (canvas.height - (maxY - minY) * scale) / 2;
    const map = point => ({ x: offsetX + (point.x - minX) * scale, y: offsetY + (point.y - minY) * scale });
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#163448'; ctx.lineWidth = Math.max(9, (track.trackWidth || 160) * scale); ctx.beginPath(); points.forEach((point, index) => { const mapped = map(point); index ? ctx.lineTo(mapped.x, mapped.y) : ctx.moveTo(mapped.x, mapped.y); }); ctx.closePath(); ctx.stroke(); ctx.strokeStyle = 'rgba(0,245,255,.32)'; ctx.lineWidth = 1.5; ctx.stroke(); return map;
  }
  function drawReplay() {
    const canvas = document.getElementById('ml-replay-canvas'); if (!canvas) return; const ctx = canvas.getContext('2d'), all = state.tracks, track = all && (all.find(item => Number(item.id) === state.selectedTrack) || all[0]); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!track || !track.spline || !track.spline.length) { ctx.fillStyle = '#9eb3c5'; ctx.font = '16px Nunito'; ctx.fillText('Loading track geometry...', 30, 50); state.raf = requestAnimationFrame(drawReplay); return; }
    const map = drawTrack(ctx, canvas, track), actual = state.snapshots.filter(snapshot => Number(snapshot.trackId) === state.selectedTrack && Array.isArray(snapshot.points) && snapshot.points.length > 1), checkpointOrder = ['Warm start', 'Middle - 50%', 'Final'], checkpoints = checkpointOrder.map(label => actual.find(snapshot => snapshot.label === label)).filter(Boolean), label = document.getElementById('ml-replay-label');
    if (!checkpoints.length) {
      ctx.fillStyle = 'rgba(3,10,17,.82)'; ctx.fillRect(250, 165, 500, 90); ctx.textAlign = 'center'; ctx.fillStyle = '#edfaff'; ctx.font = '900 18px Nunito'; ctx.fillText('NO REAL CHECKPOINTS LOADED', 500, 200); ctx.fillStyle = '#91a9bb'; ctx.font = '13px Nunito'; ctx.fillText('Train or import a model containing replay data.', 500, 226); ctx.textAlign = 'left'; label.textContent = `TRACK ${state.selectedTrack + 1} / NO CHECKPOINT DATA`; return;
    }
    const colors = ['#fb923c', '#facc15', '#4ade80'], time = state.frame * .004;
    checkpoints.forEach((snapshot, index) => {
      ctx.strokeStyle = colors[index]; ctx.globalAlpha = .42 + index * .2; ctx.lineWidth = 2.2; ctx.beginPath(); snapshot.points.forEach((point, pointIndex) => { const mapped = map(point); pointIndex ? ctx.lineTo(mapped.x, mapped.y) : ctx.moveTo(mapped.x, mapped.y); }); ctx.stroke();
      ctx.strokeStyle = '#fb7185'; ctx.globalAlpha = .9; ctx.lineWidth = 3; for (let pointIndex = 1; pointIndex < snapshot.points.length; pointIndex++) if (snapshot.points[pointIndex].offTrack) { const a = map(snapshot.points[pointIndex - 1]), b = map(snapshot.points[pointIndex]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      ctx.globalAlpha = 1; const point = snapshot.points[Math.floor((time + index * .035) * snapshot.points.length) % snapshot.points.length], mapped = map(point); ctx.fillStyle = colors[index]; ctx.shadowColor = colors[index]; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(mapped.x, mapped.y, 5 + index, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.font = '900 10px Nunito'; ctx.fillText(`${snapshot.label.toUpperCase()} / ${snapshot.finished ? `${Number(snapshot.lapTime).toFixed(2)}s` : 'NO FINISH'}`, 18, canvas.height - 58 + index * 17);
    });
    label.textContent = `TRACK ${state.selectedTrack + 1} / MEASURED CHECKPOINTS`; state.frame++; state.raf = requestAnimationFrame(drawReplay);
  }

  function boot() { installScreen(); hookSettings(); loadOurModel(); }
  window.KartBlitzMLLab = { open, close, tab, setEnabled, settingsMarkup, connect, startTraining, applyPreset, renderDecisionLesson, chooseLesson, checkDecision, renderRewardLab, explainPhase, updateTrainingExplanation, copyCommand, exportConfig, exportDemonstrations, exportModel, downloadTrainerPack, importLeaderboardGhost, selectModel, selectTrack, launchRace, replayTrack, recordHumanLap, captureRaceFrame, scoreDecision, calculateRewardFrame };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
