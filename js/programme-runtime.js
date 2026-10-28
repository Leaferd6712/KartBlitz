/* Unified upgrade programme — former R&D HQ overhaul removed.
   Migration + garage UI live in KartBlitzProgramme / main garage builders.
   Keep only ERS runtime hooks that programme bonuses still drive. */
(function(){
  if (window.__kbRndOverhaulApplied) return;
  window.__kbRndOverhaulApplied = true;

  const _kbOrigKartUpdate = window.Kart && window.Kart.prototype && window.Kart.prototype.update;
  if (window.Kart && window.Kart.prototype && _kbOrigKartUpdate) {
    window.Kart.prototype.update = function(dt, trackData, otherKarts) {
      _kbOrigKartUpdate.call(this, dt, trackData, otherKarts);
      if (this._rndERSRegen && !this.ersActive) {
        this.ersCharge = Math.min(1, this.ersCharge + this._rndERSRegen * dt);
      }
      if (this._rndERSBoost && this.ersActive) {
        const boost = Math.max(0, Math.min(2.5, this._rndERSBoost));
        const cap = (this.maxSpeed || this.baseMaxSpeed || 400) * (1 + boost * 0.08);
        if (this.speed < cap) {
          this.speed = Math.min(cap, this.speed + (this.maxSpeed || 400) * boost * 0.045 * dt);
        }
      }
    };
  }

  window.queueRnDProject = function() {
    console.info('[KartBlitzProgramme] R&D queue removed — use the UPGRADES garage tab');
  };
  window.advanceRnDSession = function() { return { successes: [], failures: [] }; };
  window.dismissRnDSuccessPopup = function() {
    const modal = document.getElementById('rnd-success-modal');
    if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
  };
  window.computeRnDTyreWearMult = function() {
    const Prog = window.KartBlitzProgramme;
    if (!Prog) return 1;
    try { return Prog.computeProgrammeTyreWearMult(getPlayerData().programme); }
    catch (e) { return 1; }
  };
})();
