"""Per-learner exploration and minibatch RNGs within one shared CUDA process."""
import contextlib
import threading
import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.buffers import RolloutBuffer
from stable_baselines3.common.policies import ActorCriticPolicy

INITIALIZATION_LOCK=threading.RLock()

class IndependentPolicy(ActorCriticPolicy):
    def __init__(self,*args,exploration_seed=42,**kwargs):
        self.exploration_seed=exploration_seed;self._exploration=None;self._pending_state=None
        super().__init__(*args,**kwargs)
    def _generator(self,device):
        if self._exploration is None or str(self._exploration.device)!=str(device):
            self._exploration=torch.Generator(device=device);self._exploration.manual_seed(self.exploration_seed)
            if self._pending_state is not None:self._exploration.set_state(self._pending_state.cpu());self._pending_state=None
        return self._exploration
    def get_extra_state(self):return {'seed':self.exploration_seed,'state':self._exploration.get_state() if self._exploration else self._pending_state}
    def set_extra_state(self,state):self.exploration_seed=state['seed'];self._pending_state=state['state'];self._exploration=None
    def forward(self,obs,deterministic=False):
        features=self.extract_features(obs);latent_pi,latent_vf=self.mlp_extractor(features)
        values=self.value_net(latent_vf);distribution=self._get_action_dist_from_latent(latent_pi)
        normal=distribution.distribution
        actions=normal.mean if deterministic else normal.mean+normal.stddev*torch.randn(normal.mean.shape,device=normal.mean.device,generator=self._generator(normal.mean.device))
        return actions.reshape((-1,*self.action_space.shape)),values,distribution.log_prob(actions)

class IndependentBuffer(RolloutBuffer):
    def __init__(self,*args,sampling_seed=42,**kwargs):super().__init__(*args,**kwargs);self.sampling_rng=np.random.default_rng(sampling_seed)
    def get(self,batch_size=None):
        assert self.full
        indices=self.sampling_rng.permutation(self.buffer_size*self.n_envs)
        if not self.generator_ready:
            for tensor in ['observations','actions','values','log_probs','advantages','returns']:self.__dict__[tensor]=self.swap_and_flatten(self.__dict__[tensor])
            self.generator_ready=True
        size=batch_size or self.buffer_size*self.n_envs
        for start in range(0,len(indices),size):yield self._get_samples(indices[start:start+size])

class IndependentPPO(PPO):
    def __init__(self,policy,*args,seed=42,**kwargs):
        # SB3 initialises global seeds and orthogonal tensors. Serialize only
        # construction; driving and independent exploration remain parallel.
        with INITIALIZATION_LOCK:
            cpu=torch.random.get_rng_state();np_state=np.random.get_state()
            cuda=torch.cuda.get_rng_state_all() if torch.cuda.is_initialized() else None
            try:
                opts=dict(kwargs.get('policy_kwargs') or {});opts['exploration_seed']=int(seed or 42);kwargs['policy_kwargs']=opts
                kwargs['rollout_buffer_class']=IndependentBuffer;kwargs['rollout_buffer_kwargs']={'sampling_seed':int(seed or 42)}
                super().__init__(IndependentPolicy,*args,seed=seed,**kwargs)
            finally:
                torch.random.set_rng_state(cpu);np.random.set_state(np_state)
                if cuda is not None:torch.cuda.set_rng_state_all(cuda)
    def set_random_seed(self,seed=None):
        # Simulator seeds live in each worker. Do not reset another learner's RNG.
        self.seed=seed
        if getattr(self,'action_space',None) is not None:self.action_space.seed(seed)
        if getattr(self,'env',None) is not None:self.env.seed(seed)
    def _setup_model(self):
        with INITIALIZATION_LOCK:
            cpu=torch.random.get_rng_state()
            try:
                torch.manual_seed(int(self.seed or 42));super()._setup_model()
                if getattr(self,'sampling_state',None):self.rollout_buffer.sampling_rng.bit_generator.state=self.sampling_state
            finally:torch.random.set_rng_state(cpu)
    def train(self):
        super().train();self.sampling_state=self.rollout_buffer.sampling_rng.bit_generator.state
