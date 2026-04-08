/**
 * 3D geometry builders for kitchen fixture types.
 */

import * as THREE from 'three';
import { metalMaterial, counterTopMaterial, chromeMaterial, ceramicMaterial } from '../materials';

export function buildSink(): THREE.Group {
  const group = new THREE.Group();
  const counter = counterTopMaterial(0xD0C8B8);
  const basin = metalMaterial(0xBBBBBB);
  const chrome = chromeMaterial();
  const cabinetMat = ceramicMaterial(0xE8E0D0);
  const shadowPanel = ceramicMaterial(0xddd4c3);

  const topGeo = new THREE.BoxGeometry(0.58, 0.04, 0.46);
  const top = new THREE.Mesh(topGeo, counter);
  top.position.y = 0.86;
  group.add(top);

  const cabinetGeo = new THREE.BoxGeometry(0.56, 0.80, 0.44);
  cabinetGeo.translate(0, 0.40, 0);
  const cabinet = new THREE.Mesh(cabinetGeo, cabinetMat);
  group.add(cabinet);

  const plinthGeo = new THREE.BoxGeometry(0.50, 0.05, 0.36);
  const plinth = new THREE.Mesh(plinthGeo, shadowPanel);
  plinth.position.y = 0.025;
  group.add(plinth);

  const doorGeo = new THREE.BoxGeometry(0.23, 0.62, 0.02);
  for (const x of [-0.12, 0.12]) {
    const door = new THREE.Mesh(doorGeo, shadowPanel);
    door.position.set(x, 0.38, 0.23);
    group.add(door);
  }

  const basinGeo = new THREE.BoxGeometry(0.42, 0.16, 0.32);
  const basinMesh = new THREE.Mesh(basinGeo, basin);
  basinMesh.position.set(0, 0.80, 0.02);
  group.add(basinMesh);

  const rimGeo = new THREE.BoxGeometry(0.46, 0.01, 0.36);
  const rim = new THREE.Mesh(rimGeo, counter);
  rim.position.set(0, 0.88, 0.02);
  group.add(rim);

  const faucetBaseGeo = new THREE.CylinderGeometry(0.015, 0.02, 0.04, 8);
  const faucetBase = new THREE.Mesh(faucetBaseGeo, chrome);
  faucetBase.position.set(0, 0.90, -0.15);
  group.add(faucetBase);

  const neckGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.14, 8);
  const neck = new THREE.Mesh(neckGeo, chrome);
  neck.position.set(0, 0.98, -0.15);
  group.add(neck);

  // Faucet spout
  const spoutGeo = new THREE.CylinderGeometry(0.01, 0.008, 0.10, 8);
  spoutGeo.rotateZ(Math.PI / 2);
  const spout = new THREE.Mesh(spoutGeo, chrome);
  spout.position.set(0, 1.04, -0.10);
  spout.rotation.x = -0.3;
  group.add(spout);

  const handleGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8);
  handleGeo.rotateZ(Math.PI / 2);
  for (const x of [-0.03, 0.03]) {
    const handle = new THREE.Mesh(handleGeo, chrome);
    handle.position.set(x, 0.92, -0.15);
    group.add(handle);
  }

  return group;
}

export function buildStove(): THREE.Group {
  const group = new THREE.Group();
  const body = metalMaterial(0xE0E0E0);
  const dark = metalMaterial(0x2A2A2A);
  const chrome = chromeMaterial();
  const glassDark = metalMaterial(0x111111);

  const bodyGeo = new THREE.BoxGeometry(0.58, 0.86, 0.56);
  bodyGeo.translate(0, 0.43, 0);
  const bodyMesh = new THREE.Mesh(bodyGeo, body);
  group.add(bodyMesh);

  const topGeo = new THREE.BoxGeometry(0.58, 0.015, 0.56);
  const top = new THREE.Mesh(topGeo, dark);
  top.position.y = 0.868;
  group.add(top);

  const controlPanelGeo = new THREE.BoxGeometry(0.54, 0.10, 0.04);
  const controlPanel = new THREE.Mesh(controlPanelGeo, body);
  controlPanel.position.set(0, 0.80, 0.26);
  group.add(controlPanel);

  const burnerPositions = [
    [-0.15, -0.14],
    [0.15, -0.14],
    [-0.15, 0.14],
    [0.15, 0.14],
  ];
  for (const [x, z] of burnerPositions) {
    const burnerGeo = new THREE.TorusGeometry(0.07, 0.008, 8, 24);
    burnerGeo.rotateX(Math.PI / 2);
    const burner = new THREE.Mesh(burnerGeo, chrome);
    burner.position.set(x, 0.88, z);
    group.add(burner);

    // Grate lines
    for (let i = -1; i <= 1; i += 2) {
      const grateGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.12, 4);
      grateGeo.rotateZ(Math.PI / 2);
      const grate = new THREE.Mesh(grateGeo, dark);
      grate.position.set(x, 0.895, z + i * 0.03);
      group.add(grate);
    }
  }

  const ovenWindowGeo = new THREE.BoxGeometry(0.34, 0.22, 0.02);
  const ovenWindow = new THREE.Mesh(ovenWindowGeo, glassDark);
  ovenWindow.position.set(0, 0.42, 0.285);
  group.add(ovenWindow);

  const handleGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.40, 6);
  handleGeo.rotateZ(Math.PI / 2);
  const handle = new THREE.Mesh(handleGeo, chrome);
  handle.position.set(0, 0.62, 0.285);
  group.add(handle);

  // Knobs
  const knobGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.01, 8);
  knobGeo.rotateX(Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    const knob = new THREE.Mesh(knobGeo, chrome);
    knob.position.set(-0.22 + i * 0.145, 0.80, 0.29);
    group.add(knob);
  }

  const kickGeo = new THREE.BoxGeometry(0.50, 0.04, 0.02);
  const kick = new THREE.Mesh(kickGeo, dark);
  kick.position.set(0, 0.04, 0.285);
  group.add(kick);

  return group;
}

export function buildFridge(): THREE.Group {
  const group = new THREE.Group();
  const body = metalMaterial(0xE8E8E8);
  const chrome = chromeMaterial();
  const dark = metalMaterial(0x333333);

  const bodyGeo = new THREE.BoxGeometry(0.68, 1.75, 0.66);
  bodyGeo.translate(0, 0.875, 0);
  const bodyMesh = new THREE.Mesh(bodyGeo, body);
  group.add(bodyMesh);

  const freezerDoorGeo = new THREE.BoxGeometry(0.62, 0.46, 0.025);
  const freezerDoor = new THREE.Mesh(freezerDoorGeo, body);
  freezerDoor.position.set(0, 1.52, 0.343);
  group.add(freezerDoor);

  const fridgeDoorGeo = new THREE.BoxGeometry(0.62, 1.18, 0.025);
  const fridgeDoor = new THREE.Mesh(fridgeDoorGeo, body);
  fridgeDoor.position.set(0, 0.59, 0.343);
  group.add(fridgeDoor);

  const freezerLineGeo = new THREE.BoxGeometry(0.64, 0.004, 0.004);
  const freezerLine = new THREE.Mesh(freezerLineGeo, dark);
  freezerLine.position.set(0, 1.29, 0.346);
  group.add(freezerLine);

  const topCapGeo = new THREE.BoxGeometry(0.70, 0.02, 0.68);
  const topCap = new THREE.Mesh(topCapGeo, dark);
  topCap.position.y = 1.76;
  group.add(topCap);

  // Handles
  const handleGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.20, 6);
  const fHandle = new THREE.Mesh(handleGeo, chrome);
  fHandle.position.set(0.26, 1.50, 0.345);
  group.add(fHandle);
  const rHandleGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.46, 6);
  const rHandle = new THREE.Mesh(rHandleGeo, chrome);
  rHandle.position.set(0.26, 0.77, 0.345);
  group.add(rHandle);

  const kickGeo = new THREE.BoxGeometry(0.54, 0.05, 0.05);
  const kick = new THREE.Mesh(kickGeo, dark);
  kick.position.set(0, 0.025, 0.31);
  group.add(kick);

  return group;
}
