/// <reference lib="webworker" />

import {DID_NOT_SELECT_EXOTIC, FORCE_USE_NO_EXOTIC, PERMUTATION_PACKAGE, RESULTS_PACKAGE} from "../../data/constants";
import {ModInformation} from "../../data/ModInformation";
import {ArmorStat, SpecialArmorStat, StatModifier} from "../../data/enum/armor-stat";
import {Configuration} from "../../data/configuration";

addEventListener('message', ({data}) => {


  const allArmorPermutations = new Uint32Array(data.permutations);
  const startPosition = data.startPosition;
  const config = data.config as Configuration;

  console.time(`WebWorker: Results Builder Helper ${startPosition}`)

  let currentClass = config.characterClass;

  // How many tiers can we get? This is used to limit the stat tier selection
  let maximumPossibleTiers = [0, 0, 0, 0, 0, 0]
  let statCombo3x100 = new Set();
  let statCombo4x100 = new Set();

  let results = []

  for (let i = 0; i < allArmorPermutations.length; i += PERMUTATION_PACKAGE.WIDTH) {
    // Skip if we want to filter out a specific exotic
    const permutation = allArmorPermutations.subarray(i, i + PERMUTATION_PACKAGE.WIDTH)
    if (config.selectedExoticHash > DID_NOT_SELECT_EXOTIC && permutation[PERMUTATION_PACKAGE.EXOTIC_ID] != config.selectedExoticHash) {
      continue
    }
    if (config.selectedExoticHash == FORCE_USE_NO_EXOTIC && permutation[PERMUTATION_PACKAGE.EXOTIC_ID] != 0) {
      continue
    }
    // Ignore this permutation if not every item is masterworked
    if (config.onlyUseMasterworkedItems && permutation[PERMUTATION_PACKAGE.MASTERWORK_NUMBER] != 0xF) {
      continue
    }

    let stats = [
      permutation[4] + 2,
      permutation[5] + 2,
      permutation[6] + 2,
      permutation[7] + 2,
      permutation[8] + 2,
      permutation[9] + 2,
    ]

    if (config.assumeMasterworked) {
      for (let n = 0; n < 6; n++) stats[n] += 8;
    } else {
      // add each item individually
      for (let n = 0; n < 4; n++) {
        if ((permutation[11] & (1 << n)) > 0)
          for (let n = 0; n < 6; n++) stats[n] += 2;
      }
    }

    let requiredElements = config.selectedArmorAffinities.slice()
    // Apply mods
    for (const mod of config.enabledMods) {
      requiredElements.unshift(ModInformation[mod].requiredArmorAffinity)
      for (const bonus of ModInformation[mod].bonus) {
        switch (bonus.stat) {
          case SpecialArmorStat.ClassAbilityRegenerationStat:
            stats[[1, 0, 3][currentClass]] += bonus.value;
            break;
          default:
            stats[bonus.stat] += bonus.value;
            break;
        }
      }
    }


    // check elemental affinities. The setting disables this feature completely
    if (!config.ignoreArmorAffinitiesOnMasterworkedItems) {
      // I only want the first 5 entries
      // And configured mods always take priority.
      requiredElements = requiredElements.slice(0, 5)

      // find the existing elements
      let existingElements = []
      for (let n = 0; n < 4; n++) {
        let isMwd = (permutation[11] & (1 << n)) > 0
        if (!isMwd) continue;
        let element = (permutation[12] >> (n * 3)) & 0x7
        existingElements.push(element)
      }

      let slotsForAnyElement = 5 - existingElements.length
      for (let requiredElement of requiredElements) {
        const index = existingElements.indexOf(requiredElement);
        if (index > -1) {
          existingElements.splice(index, 1) // remove the entry
        } else {
          slotsForAnyElement--;
        }
      }
      if (slotsForAnyElement < 0) {
        continue;
      }
    }

    // find the difference
    let usedMods = stats
      .map((value, index: ArmorStat) => Math.max(0, config.minimumStatTier[index] * 10 - value))
      .reduce((previousValue, currentValue, currentIndex) => {
        if (currentValue == 0) return previousValue;

        let modMinor = (currentValue % 10 > 0 && currentValue % 10 <= 5) ? 1 : 0
        let modMajor = Math.ceil(Math.max(0, currentValue - modMinor * 5) / 10)
        if (modMinor) previousValue.push(1 + (2 * currentIndex) as StatModifier)
        for (let n = 0; n < modMajor; n++) {
          previousValue.push(1 + (2 * currentIndex + 1) as StatModifier)
        }
        return previousValue;
      }, [] as StatModifier[])

    // Skip if we use too many mods
    if (usedMods.length > config.maximumStatMods)
      continue;

    //////////////// Fix wasted stats, if possible
    if (config.tryLimitWastedStats) {
      let waste = [
        (stats[ArmorStat.Mobility] + ((usedMods.indexOf(StatModifier.MINOR_MOBILITY) > -1) ? 5 : 0)),
        (stats[ArmorStat.Resilience] + ((usedMods.indexOf(StatModifier.MINOR_RESILIENCE) > -1) ? 5 : 0)),
        (stats[ArmorStat.Recovery] + ((usedMods.indexOf(StatModifier.MINOR_RECOVERY) > -1) ? 5 : 0)),
        (stats[ArmorStat.Discipline] + ((usedMods.indexOf(StatModifier.MINOR_DISCIPLINE) > -1) ? 5 : 0)),
        (stats[ArmorStat.Intellect] + ((usedMods.indexOf(StatModifier.MINOR_INTELLECT) > -1) ? 5 : 0)),
        (stats[ArmorStat.Strength] + ((usedMods.indexOf(StatModifier.MINOR_STRENGTH) > -1) ? 5 : 0))
      ].map((v, i) => [v % 10, i, v]).sort((a, b) => b[0] - a[0])

      if (usedMods.length < config.maximumStatMods)
        for (let id = usedMods.length; id < config.maximumStatMods; id++) {
          // First round: bring stats from X5 to Y0 (55 -> 60)
          let result = waste.filter(k => k[2] < 100).filter(k => k[0] == 5)[0]
          if (!result) {
            break;
            // Second round, bring stats from X6/X7/X8/X9 to Y1/Y2/Y3/Y4 (56 -> 61)
            // result = waste.filter(a => a[0] > 5).sort((a, b) => a[0] - b[0])[0]
            // if (!result) break;
          }
          result[0] -= 5;
          usedMods.push(1 + 2 * result[1])
        }


      // Ignore results with wasted stats if the setting is used
      if (config.onlyShowResultsWithNoWastedStats && waste.reduce((p, v) => p + v[0], 0) > 0)
        continue;
    }

    //////////////// Statistics

    for (let n = 0; n < 6; n++) {
      let stat = Math.min(10,
        Math.floor(stats[n] / 10)
        + (config.maximumStatMods - usedMods.length)
        + usedMods.filter(d => Math.floor((d - 1) / 2) == n).length
      )

      if (maximumPossibleTiers[n] < stat)
        maximumPossibleTiers[n] = stat
    }

    // Calculate how many 100 stats we can achieve
    let openModSlots = config.maximumStatMods - usedMods.length
    if (openModSlots >= 0) {
      let todo = stats.map((value, index: ArmorStat) =>
        value + 10 * usedMods.filter(d => Math.floor((d - 1) / 2) == index).length
      ).map((value, index: ArmorStat) => [Math.max(0, Math.ceil((100 - value) / 10)), index])
        .sort((a, b) => a[0] - b[0]);
      for (let statId in todo) {
        while (openModSlots > 0 && todo[statId][0] > 0) {
          openModSlots--;
          todo[statId][0]--;
        }
      }
      const zeroMods = todo.filter(d => d[0] == 0);
      let stats100amount = zeroMods.length
      let stats100values = zeroMods.reduce((p, d) => {
        p += 1 << d[1];
        return p;
      }, 0);


      if (stats100amount == 3) statCombo3x100.add(stats100values);
      if (stats100amount == 4) statCombo4x100.add(stats100values);
    }


    // SECOND ROUND for stat waste reduction
    if (config.tryLimitWastedStats && usedMods.length < config.maximumStatMods) {
      let waste = [
        (stats[ArmorStat.Mobility] + ((usedMods.indexOf(StatModifier.MINOR_MOBILITY) > -1) ? 5 : 0)),
        (stats[ArmorStat.Resilience] + ((usedMods.indexOf(StatModifier.MINOR_RESILIENCE) > -1) ? 5 : 0)),
        (stats[ArmorStat.Recovery] + ((usedMods.indexOf(StatModifier.MINOR_RECOVERY) > -1) ? 5 : 0)),
        (stats[ArmorStat.Discipline] + ((usedMods.indexOf(StatModifier.MINOR_DISCIPLINE) > -1) ? 5 : 0)),
        (stats[ArmorStat.Intellect] + ((usedMods.indexOf(StatModifier.MINOR_INTELLECT) > -1) ? 5 : 0)),
        (stats[ArmorStat.Strength] + ((usedMods.indexOf(StatModifier.MINOR_STRENGTH) > -1) ? 5 : 0))
      ].map((v, i) => [v % 10, i, v]).sort((a, b) => b[0] - a[0])

      for (let id = usedMods.length; id < config.maximumStatMods; id++) {
        let result = waste.filter(k => k[2] < 100).filter(a => a[0] > 5).sort((a, b) => a[0] - b[0])[0]
        if (!result) break;
        result[0] -= 5;
        usedMods.push(1 + 2 * result[1])
      }
    }

    results.push([
      startPosition + i / PERMUTATION_PACKAGE.WIDTH, // Index of the current set in the big permutation array
      ...usedMods // all used mods.
    ])
  }


  // build a buffer
  let len = (RESULTS_PACKAGE.WIDTH * results.length) * 2
  const buffer = new ArrayBuffer(len)
  const view = new Uint16Array(buffer);
  for (let i = 0; i < results.length; i++) {
    // the ID of the permutation. Split loByte and hiByte, as the ID gets quite large..
    view[i * RESULTS_PACKAGE.WIDTH + RESULTS_PACKAGE.PERMUTATION_ID_LOBYTE] = results[i][0] & 0xffff
    view[i * RESULTS_PACKAGE.WIDTH + RESULTS_PACKAGE.PERMUTATION_ID_HIBYTE] = (results[i][0] & (0xffff << 16)) >> 16
    for (let n = 0; n < 6; n++)
      view[i * RESULTS_PACKAGE.WIDTH + RESULTS_PACKAGE.USED_MOD1 + n] = results[i][n + 1];
  }
  console.timeEnd(`WebWorker: Results Builder Helper ${startPosition}`)
  postMessage({
    buffer,
    maximumPossibleTiers,
    statCombo3x100,
    statCombo4x100
  }, [buffer]);
});
