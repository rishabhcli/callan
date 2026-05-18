import React, { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Html,
  OrbitControls,
  Float,
  RoundedBox,
  Environment,
  ContactShadows,
  Stars
} from '@react-three/drei';
import * as THREE from 'three';

/**
 * Palette pulled into a JS object so the 3D scene materials match the CSS.
 */
export const PALETTE = {
  pearl:    '#F3E6BD',
  apricot:  '#D8973C',
  candy:    '#FD9BB7',
  brownRed: '#AD2831',
  cherry:   '#640D14',
  cherryDeep: '#2A0810',
  cherryFar:  '#14040A'
};

/**
 * Static node definitions. Position values are in world units;
 * the camera is configured below to keep the cluster centered.
 */
export const SCENE_NODES = [
  {
    id: 'memory',
    label: 'Super Memory',
    sub: 'long-term memory',
    code: 'SUM',
    position: [0, 1.4, 0],
    size: [2.4, 1.4, 1.4],
    accent: PALETTE.apricot,
    glow: PALETTE.candy,
    description: 'Knowledge graph linking every business, evidence shard, transcript, and outcome.'
  },
  {
    id: 'caller',
    label: 'Callers',
    sub: 'agentphone voice',
    code: 'CAL',
    position: [-3.4, -0.4, 1.2],
    size: [1.8, 1.2, 1.2],
    accent: PALETTE.candy,
    glow: PALETTE.candy,
    description: 'Multiple voice agent instances dialing leads, recording transcripts, pitching builds.'
  },
  {
    id: 'scraper',
    label: 'Scraper',
    sub: 'browser swarm',
    code: 'SCR',
    position: [3.4, -0.4, 1.2],
    size: [1.8, 1.2, 1.2],
    accent: PALETTE.apricot,
    glow: PALETTE.apricot,
    description: 'Cloud browser fleet harvesting evidence: search, directories, websites, social, maps.'
  },
  {
    id: 'analyst',
    label: 'Analyst',
    sub: 'needs + growth',
    code: 'ANA',
    position: [-2.0, -2.3, -0.8],
    size: [1.6, 1.0, 1.0],
    accent: PALETTE.pearl,
    glow: PALETTE.apricot,
    description: 'Call postmortems, needs assessment, growth plans, presence scoring.'
  },
  {
    id: 'mailer',
    label: 'Mailer',
    sub: 'invoice + reply',
    code: 'MAI',
    position: [2.0, -2.3, -0.8],
    size: [1.6, 1.0, 1.0],
    accent: PALETTE.apricot,
    glow: PALETTE.candy,
    description: 'AgentMail threads, Stripe payment links, autoreplies, mailbox routing.'
  },
  {
    id: 'builder',
    label: 'Builder',
    sub: 'live site build',
    code: 'BLD',
    position: [0, -3.8, 0.4],
    size: [2.4, 1.2, 1.2],
    accent: PALETTE.candy,
    glow: PALETTE.candy,
    description: 'Browser Use + Lovable building the customer site live, with shareable preview.'
  }
];

/**
 * Edge definitions: every worker box is wired through the memory box at top.
 */
const SCENE_EDGES = [
  ['memory', 'caller'],
  ['memory', 'scraper'],
  ['memory', 'analyst'],
  ['memory', 'mailer'],
  ['memory', 'builder']
];

function NodeMesh({ node, state, count, isHovered, isSelected, onPointerEnter, onPointerLeave, onClick }) {
  const groupRef = useRef();
  const glowRef = useRef();
  const wireRef = useRef();
  const running = state === 'running';
  const success = state === 'success';
  const errored = state === 'error';

  // Bobbing + pulse animation
  useFrame((threeState, delta) => {
    if (!groupRef.current) return;
    const t = threeState.clock.elapsedTime;

    // gentle bobbing
    const bob = Math.sin(t * 0.8 + node.position[0]) * 0.06;
    groupRef.current.position.y = node.position[1] + bob;
    groupRef.current.rotation.y = Math.sin(t * 0.18 + node.position[0]) * 0.08;

    // selected scale up
    const target = isSelected ? 1.06 : isHovered ? 1.04 : 1.0;
    groupRef.current.scale.x += (target - groupRef.current.scale.x) * Math.min(1, delta * 8);
    groupRef.current.scale.y += (target - groupRef.current.scale.y) * Math.min(1, delta * 8);
    groupRef.current.scale.z += (target - groupRef.current.scale.z) * Math.min(1, delta * 8);

    // glow intensity pulses if running
    if (glowRef.current) {
      const base = running ? 1.0 : success ? 0.7 : errored ? 0.5 : 0.35;
      const wobble = running ? (0.5 + 0.5 * Math.sin(t * 4)) * 0.6 : 0;
      glowRef.current.material.opacity = Math.min(1, base + wobble);
    }
    if (wireRef.current && running) {
      wireRef.current.material.opacity = 0.6 + 0.4 * Math.sin(t * 5);
    } else if (wireRef.current) {
      wireRef.current.material.opacity = 0.18;
    }
  });

  const [sx, sy, sz] = node.size;
  const accent = errored ? PALETTE.brownRed : node.accent;

  return (
    <group
      ref={groupRef}
      position={node.position}
      onPointerOver={(e) => { e.stopPropagation(); onPointerEnter?.(node.id); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { onPointerLeave?.(node.id); document.body.style.cursor = ''; }}
      onClick={(e) => { e.stopPropagation(); onClick?.(node.id); }}
    >
      {/* main solid box, tinted brown-red, lit subtly */}
      <RoundedBox args={[sx, sy, sz]} radius={0.12} smoothness={4} castShadow receiveShadow>
        <meshStandardMaterial
          color={PALETTE.brownRed}
          roughness={0.6}
          metalness={0.15}
          emissive={accent}
          emissiveIntensity={running ? 0.45 : success ? 0.28 : 0.18}
        />
      </RoundedBox>

      {/* wireframe halo so the box reads even in dim light */}
      <mesh ref={wireRef}>
        <boxGeometry args={[sx + 0.02, sy + 0.02, sz + 0.02]} />
        <meshBasicMaterial color={accent} wireframe transparent opacity={0.18} />
      </mesh>

      {/* soft glow plane behind the box */}
      <mesh ref={glowRef} position={[0, 0, -sz / 2 - 0.05]} renderOrder={-1}>
        <planeGeometry args={[sx * 2, sy * 2]} />
        <meshBasicMaterial color={node.glow} transparent opacity={0.35} depthWrite={false} />
      </mesh>

      {/* label, anchored to top face */}
      <Html
        position={[0, sy / 2 + 0.05, sz / 2 + 0.05]}
        center
        distanceFactor={6}
        zIndexRange={[10, 0]}
        style={{ pointerEvents: 'none' }}
        transform
      >
        <div className="scene-node-label">
          <div className="scene-node-label-row">
            <span className="scene-node-code">{node.code}</span>
            <span className={`scene-node-state scene-node-state-${state}`}>{state === 'running' ? 'live' : state === 'error' ? 'error' : state === 'success' ? 'ok' : 'idle'}</span>
          </div>
          <div className="scene-node-name">{node.label}</div>
          <div className="scene-node-sub">{node.sub}</div>
          {count > 0 ? <div className="scene-node-count">{count}<span className="scene-node-count-key">/min</span></div> : null}
        </div>
      </Html>
    </group>
  );
}

function EdgeLine({ from, to, active }) {
  const ref = useRef();
  const positions = useMemo(() => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    mid.z += 0.4; // gentle bulge toward viewer
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const points = curve.getPoints(32);
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      flat[i * 3] = p.x;
      flat[i * 3 + 1] = p.y;
      flat[i * 3 + 2] = p.z;
    });
    return flat;
  }, [from, to]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.material.opacity = active
      ? 0.65 + 0.35 * Math.sin(t * 4)
      : 0.20;
  });

  return (
    <line ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={active ? PALETTE.apricot : PALETTE.candy} transparent opacity={0.22} />
    </line>
  );
}

function SceneInside({
  hovered, setHovered, onSelect, selected, states, counters
}) {
  const groupRef = useRef();
  useFrame((_, delta) => {
    if (groupRef.current) {
      // very subtle drift to give the whole cluster life
      groupRef.current.rotation.y += delta * 0.02;
    }
  });

  const nodeById = useMemo(() => Object.fromEntries(SCENE_NODES.map((n) => [n.id, n])), []);

  return (
    <>
      <color attach="background" args={[PALETTE.cherryFar]} />
      <fog attach="fog" args={[PALETTE.cherryFar, 9, 22]} />

      <ambientLight intensity={0.35} color={PALETTE.pearl} />
      <directionalLight
        position={[5, 8, 6]}
        intensity={1.2}
        color={PALETTE.apricot}
        castShadow
      />
      <pointLight position={[-4, -3, 4]} intensity={0.9} color={PALETTE.candy} />
      <pointLight position={[4, 5, -3]} intensity={0.6} color={PALETTE.apricot} />

      <Stars radius={50} depth={30} count={1200} factor={2} fade speed={0.5} />

      <ContactShadows
        position={[0, -4.6, 0]}
        opacity={0.6}
        scale={18}
        blur={2.6}
        far={6}
        color={PALETTE.cherry}
      />

      <group ref={groupRef}>
        {SCENE_EDGES.map(([fromId, toId]) => {
          const from = nodeById[fromId];
          const to = nodeById[toId];
          const active = states[fromId] === 'running' || states[toId] === 'running';
          return (
            <EdgeLine
              key={`${fromId}->${toId}`}
              from={from.position}
              to={to.position}
              active={active}
            />
          );
        })}

        {SCENE_NODES.map((node) => (
          <Float
            key={node.id}
            speed={1.4}
            rotationIntensity={0.15}
            floatIntensity={0.25}
            floatingRange={[-0.08, 0.08]}
          >
            <NodeMesh
              node={node}
              state={states[node.id] || 'idle'}
              count={counters[node.id] || 0}
              isHovered={hovered === node.id}
              isSelected={selected === node.id}
              onPointerEnter={setHovered}
              onPointerLeave={(id) => setHovered((h) => (h === id ? null : h))}
              onClick={onSelect}
            />
          </Float>
        ))}
      </group>

      <OrbitControls
        enablePan
        enableZoom
        enableRotate
        minDistance={6}
        maxDistance={18}
        minPolarAngle={Math.PI * 0.18}
        maxPolarAngle={Math.PI * 0.82}
        target={[0, -1, 0]}
        dampingFactor={0.08}
        rotateSpeed={0.7}
        zoomSpeed={0.6}
        panSpeed={0.6}
      />
    </>
  );
}

function CameraFlight({ to }) {
  const { camera } = useThree();
  const target = useMemo(() => new THREE.Vector3(...to), [to]);
  useFrame((_, delta) => {
    camera.position.lerp(target, Math.min(1, delta * 1.4));
  });
  return null;
}

export default function AgentScene({
  states = {},
  counters = {},
  selectedId = null,
  onSelect = () => {}
}) {
  const [hovered, setHovered] = useState(null);

  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: [0, 1.2, 11], fov: 45, near: 0.1, far: 100 }}
      style={{ background: 'transparent' }}
    >
      <Suspense fallback={null}>
        <SceneInside
          hovered={hovered}
          setHovered={setHovered}
          onSelect={onSelect}
          selected={selectedId}
          states={states}
          counters={counters}
        />
      </Suspense>
    </Canvas>
  );
}
