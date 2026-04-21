import { useEffect, useMemo } from "react";
import { bus } from "../game/bus";
import { ITEMS } from "../game/inventory/items";
import { selectInventorySlots, selectJobXp, useGameStore } from "../game/store/gameStore";
import { levelFromXp } from "../game/jobs/xpTable";
import { JOBS } from "../game/jobs/jobs";
import {
  selectOpenStationDefId,
  useCraftingStore,
} from "../game/store/craftingStore";
import { craftingStations } from "../game/crafting/stations";
import { recipesForStation } from "../game/crafting/recipes";
import { countInInventory } from "../game/crafting/operations";
import type { RecipeDef } from "../game/crafting/types";
import { showToast } from "./store/ui";
import "./CraftingModal.css";

/**
 * Skill-agnostic crafting modal. Opens whenever `useCraftingStore` has a
 * station def id set. Lists every recipe the station can craft, filtered by
 * the station's skill. Clicking "Craft" emits `crafting:begin`; WorldScene
 * decides whether to run the minigame (anvil-style) or apply instantly
 * (smelter-style).
 */
export function CraftingModal() {
  const stationDefId = useCraftingStore(selectOpenStationDefId);
  const slots = useGameStore(selectInventorySlots);
  const xp = useGameStore(selectJobXp);

  useEffect(() => {
    if (!stationDefId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [stationDefId]);

  const station = stationDefId ? craftingStations.tryGet(stationDefId) : null;

  const availableRecipes = useMemo<RecipeDef[]>(() => {
    if (!station) return [];
    return recipesForStation(station.kind).filter((r) => r.skill === station.skill);
  }, [station]);

  if (!stationDefId || !station) return null;

  const skillLevel = levelFromXp(xp[station.skill] ?? 0);
  const skillName = JOBS[station.skill].name;

  const close = () => {
    useCraftingStore.getState().closeStation();
    bus.emitTyped("crafting:close");
  };

  const onCraft = (recipe: RecipeDef) => {
    if (skillLevel < recipe.levelReq) {
      showToast(`${skillName} Lv ${recipe.levelReq} required.`, 1500, "warn");
      return;
    }
    // Final input check at click time — inventory may have shifted.
    for (const inp of recipe.inputs) {
      if (countInInventory(slots, inp.itemId) < inp.qty) {
        showToast(`Missing ${ITEMS[inp.itemId]?.name ?? inp.itemId}.`, 1500, "warn");
        return;
      }
    }
    bus.emitTyped("crafting:begin", {
      stationDefId: station.id,
      recipeId: recipe.id,
    });
    // Minigame-bearing recipes close the modal so the Phaser overlay takes
    // the screen; instant crafts (smelter) keep it open so the player can
    // queue up more without re-walking to the station.
    if (recipe.minigame) close();
  };

  return (
    <div className="craft-backdrop" onMouseDown={close}>
      <div
        className="px-panel craft-panel"
        role="dialog"
        aria-label={station.name}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ borderColor: station.accentColor }}
      >
        <div className="px-header">
          <span className="px-header-title">{station.name}</span>
          <button className="px-close" onClick={close} aria-label="Close">
            ×
          </button>
        </div>

        <div className="craft-topline">
          <span>
            {skillName} · <strong>Lv {skillLevel}</strong>
          </span>
          <span className="craft-topline-hint">
            {station.kind === "smelter" ? "Instant" : "Timing minigame"}
          </span>
        </div>

        <div className="craft-list">
          {availableRecipes.length === 0 ? (
            <div className="craft-empty">No recipes for this station yet.</div>
          ) : (
            availableRecipes.map((r) => {
              const outDef = ITEMS[r.output.itemId];
              const owned = r.inputs.map((inp) => countInInventory(slots, inp.itemId));
              const hasAll = r.inputs.every((inp, i) => owned[i] >= inp.qty);
              const levelOk = skillLevel >= r.levelReq;
              const disabled = !hasAll || !levelOk;
              return (
                <div key={r.id} className={`craft-row${disabled ? " is-locked" : ""}`}>
                  <div className="px-slot craft-row-slot">
                    <img
                      className="craft-row-icon"
                      src={outDef?.icon}
                      alt=""
                      draggable={false}
                    />
                    {r.output.qty > 1 && (
                      <span className="px-slot-qty">×{r.output.qty}</span>
                    )}
                  </div>
                  <div className="craft-row-info">
                    <div className="craft-row-name">
                      {r.name}
                      {r.levelReq > 1 && (
                        <span
                          className={`craft-row-level${levelOk ? "" : " is-locked"}`}
                        >
                          Lv {r.levelReq}
                        </span>
                      )}
                    </div>
                    <div className="craft-row-inputs">
                      {r.inputs.map((inp, i) => {
                        const def = ITEMS[inp.itemId];
                        const have = owned[i];
                        const ok = have >= inp.qty;
                        return (
                          <span
                            key={inp.itemId}
                            className={`craft-input${ok ? "" : " is-missing"}`}
                          >
                            {def?.name ?? inp.itemId}{" "}
                            <span className="craft-input-count">
                              {have}/{inp.qty}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                    <div className="craft-row-xp">+{r.xpReward} {skillName} XP</div>
                  </div>
                  <button
                    className="px-btn craft-row-btn"
                    disabled={disabled}
                    onClick={() => onCraft(r)}
                  >
                    {r.minigame ? "Forge" : "Smelt"}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="px-footer">E / right-click to open · ESC to close</div>
      </div>
    </div>
  );
}
