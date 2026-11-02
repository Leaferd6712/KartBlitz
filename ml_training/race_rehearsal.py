"""An opt-in PPO challenger with post-update rehearsal of a frozen fast teacher."""
import numpy as np
import torch
from stable_baselines3 import PPO


class RehearsalPPO(PPO):
    def attach_teacher(self, observations, raw_targets, *, updates=4, learning_rate=1e-5):
        self._teacher_obs = torch.as_tensor(observations, dtype=torch.float32, device=self.device)
        self._teacher_targets = torch.as_tensor(raw_targets, dtype=torch.float32, device=self.device)
        if self._teacher_obs.ndim != 2 or self._teacher_obs.shape[1] != self.observation_space.shape[0] or self._teacher_targets.shape != (len(observations), 4):
            raise ValueError('Teacher observation/action dimensions differ')
        if not len(observations) or not torch.isfinite(self._teacher_obs).all() or not torch.isfinite(self._teacher_targets).all():
            raise ValueError('Teacher examples must be nonempty and finite')
        self._teacher_updates = updates
        self._teacher_parameters = list(self.policy.mlp_extractor.policy_net.parameters()) + list(self.policy.action_net.parameters())
        self._teacher_optimizer = torch.optim.Adam(self._teacher_parameters, lr=learning_rate)

    def teacher_error(self):
        features = self.policy.extract_features(self._teacher_obs)
        means = self.policy.action_net(self.policy.mlp_extractor.forward_actor(features))
        return ((means - self._teacher_targets) ** 2).mean()

    def rehearse(self):
        if not hasattr(self, '_teacher_obs'):
            return
        weights = torch.as_tensor([3., 1., 2., .25], device=self.device)
        for _ in range(self._teacher_updates):
            index = torch.randint(len(self._teacher_obs), (min(256, len(self._teacher_obs)),), device=self.device)
            features = self.policy.extract_features(self._teacher_obs[index])
            means = self.policy.action_net(self.policy.mlp_extractor.forward_actor(features))
            loss = ((means - self._teacher_targets[index]) ** 2 * weights).mean()
            self._teacher_optimizer.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(self._teacher_parameters, .5)
            self._teacher_optimizer.step()

    def train(self):
        super().train()
        self.rehearse()

    def _excluded_save_params(self):
        # Weights remain standard PPO-compatible. Rehearsal data/provenance are
        # separate files and are deliberately reattached for a new experiment.
        return super()._excluded_save_params() + ['_teacher_obs', '_teacher_targets', '_teacher_optimizer', '_teacher_parameters']
