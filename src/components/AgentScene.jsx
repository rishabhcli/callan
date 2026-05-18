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
  superBlue:'#58A8FF',
  lovableBlue: '#4B73FF',
  lovablePink: '#FF66F4',
  lovableRed: '#FF0105',
  lovableOrange: '#FE7B02',
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
    label: 'Supermemory',
    sub: 'long-term memory',
    code: 'SM',
    position: [0, 1.78, -0.28],
    size: [2.16, 1.14, 1.08],
    accent: PALETTE.superBlue,
    glow: '#A7CBF2',
    description: 'Knowledge graph linking every business, evidence shard, transcript, and outcome.'
  },
  {
    id: 'caller',
    label: 'Agent Phone',
    sub: 'Caller logs and sessions',
    code: 'AP',
    position: [-1.72, 0.02, 0.64],
    size: [1.5, 0.94, 0.94],
    accent: PALETTE.candy,
    glow: PALETTE.candy,
    description: 'Multiple voice agent instances dialing leads, recording transcripts, pitching builds.'
  },
  {
    id: 'scraper',
    label: 'Browser Use',
    sub: 'Browser Scraper',
    code: 'SCR',
    position: [1.72, 0.02, 0.64],
    size: [1.5, 0.94, 0.94],
    accent: PALETTE.apricot,
    glow: PALETTE.apricot,
    description: 'Cloud browser fleet harvesting evidence, scoring needs, and writing growth postmortems.'
  },
  {
    id: 'mailer',
    label: 'Agent Mail',
    sub: 'inbox + replies',
    code: 'AM',
    position: [-1.28, -2.22, 0.12],
    size: [1.48, 0.9, 0.9],
    accent: PALETTE.apricot,
    glow: PALETTE.candy,
    description: 'AgentMail threads, Stripe payment links, autoreplies, mailbox routing.'
  },
  {
    id: 'builder',
    label: 'Lovable',
    sub: 'Lovable build session',
    code: 'BU',
    position: [1.28, -2.22, 0.12],
    size: [1.78, 0.96, 0.98],
    accent: PALETTE.lovablePink,
    glow: PALETTE.lovableBlue,
    description: 'Browser Use drives the Lovable building session live, with a shareable preview.'
  }
];

const HUB_POSITION = [0, -0.64, 0.22];
const SCENE_EDGES = SCENE_NODES.map((node) => node.id);

function SculptBar({ args, position, rotation = [0, 0, 0], color, emissive, opacity = 1 }) {
  const radius = Math.max(0.012, Math.min(args[0], args[1]) * 0.3);
  return (
    <RoundedBox args={args} radius={radius} smoothness={5} position={position} rotation={rotation} castShadow>
      <meshStandardMaterial
        color={color}
        roughness={0.46}
        metalness={0.18}
        emissive={emissive || color}
        emissiveIntensity={0.08}
        transparent={opacity < 1}
        opacity={opacity}
      />
    </RoundedBox>
  );
}

function SculptDisc({ radius, position, scale = [1, 1, 1], color, opacity = 1 }) {
  return (
    <mesh position={position} scale={scale} castShadow>
      <circleGeometry args={[radius, 48]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.12}
        roughness={0.5}
        metalness={0.1}
        side={THREE.DoubleSide}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
      />
    </mesh>
  );
}

function SculptureBackplate({ width, height, color, accent }) {
  return (
    <RoundedBox args={[width, height, 0.055]} radius={0.08} smoothness={5} position={[0, 0, -0.014]} castShadow>
      <meshStandardMaterial
        color={color}
        roughness={0.68}
        metalness={0.16}
        emissive={accent}
        emissiveIntensity={0.05}
      />
    </RoundedBox>
  );
}

function SupermemoryMark({ color }) {
  return (
    <group>
      <SculptBar args={[0.46, 0.105, 0.12]} position={[0.15, 0.17, 0.04]} color={color} />
      <SculptBar args={[0.5, 0.105, 0.12]} position={[0.02, 0.03, 0.065]} rotation={[0, 0, -0.78]} color={color} />
      <SculptBar args={[0.46, 0.105, 0.12]} position={[-0.15, -0.17, 0.04]} color={color} />
      <SculptBar args={[0.5, 0.105, 0.12]} position={[-0.02, -0.03, 0.065]} rotation={[0, 0, -0.78]} color={color} />
    </group>
  );
}

function PhoneMark({ color }) {
  return (
    <group rotation={[0, 0, -0.62]}>
      <mesh position={[0, 0.02, 0.075]} castShadow>
        <torusGeometry args={[0.34, 0.048, 12, 36, Math.PI * 1.08]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.1} roughness={0.42} metalness={0.18} />
      </mesh>
      <SculptBar args={[0.22, 0.13, 0.13]} position={[0.31, 0.04, 0.08]} rotation={[0, 0, 0.12]} color={color} />
      <SculptBar args={[0.22, 0.13, 0.13]} position={[-0.31, 0.04, 0.08]} rotation={[0, 0, -0.12]} color={color} />
    </group>
  );
}

function ScraperMark({ color }) {
  return (
    <group>
      <SculptBar args={[0.68, 0.07, 0.1]} position={[0, 0.24, 0.045]} color={color} />
      <SculptBar args={[0.68, 0.07, 0.1]} position={[0, -0.2, 0.045]} color={color} opacity={0.78} />
      <SculptBar args={[0.07, 0.44, 0.1]} position={[-0.34, 0.02, 0.045]} color={color} opacity={0.78} />
      <SculptBar args={[0.07, 0.44, 0.1]} position={[0.34, 0.02, 0.045]} color={color} opacity={0.78} />
      <mesh position={[-0.12, -0.02, 0.085]} castShadow>
        <torusGeometry args={[0.14, 0.023, 8, 24]} />
        <meshStandardMaterial color={PALETTE.pearl} emissive={PALETTE.pearl} emissiveIntensity={0.06} roughness={0.48} />
      </mesh>
      <SculptBar args={[0.22, 0.045, 0.09]} position={[0.05, -0.17, 0.09]} rotation={[0, 0, -0.78]} color={PALETTE.pearl} />
      <SculptBar args={[0.2, 0.04, 0.08]} position={[0.23, 0.02, 0.09]} rotation={[0, 0, 0.44]} color={PALETTE.candy} />
      <SculptBar args={[0.2, 0.04, 0.08]} position={[0.23, -0.08, 0.09]} rotation={[0, 0, -0.44]} color={PALETTE.candy} />
      <SculptDisc radius={0.035} position={[0.12, -0.03, 0.1]} color={PALETTE.candy} />
      <SculptDisc radius={0.035} position={[0.34, 0.07, 0.1]} color={PALETTE.candy} />
      <SculptDisc radius={0.035} position={[0.34, -0.15, 0.1]} color={PALETTE.candy} />
    </group>
  );
}

function AgentMailMark({ color }) {
  return (
    <group>
      <SculptureBackplate width={0.7} height={0.46} color="#35101A" accent={color} />
      <SculptBar args={[0.7, 0.075, 0.1]} position={[0, 0.22, 0.05]} color={color} />
      <SculptBar args={[0.7, 0.075, 0.1]} position={[0, -0.22, 0.05]} color={color} />
      <SculptBar args={[0.075, 0.44, 0.1]} position={[-0.35, 0, 0.05]} color={color} />
      <SculptBar args={[0.075, 0.44, 0.1]} position={[0.35, 0, 0.05]} color={color} />
      <SculptBar args={[0.42, 0.055, 0.1]} position={[-0.15, 0.02, 0.08]} rotation={[0, 0, -0.56]} color={PALETTE.pearl} />
      <SculptBar args={[0.42, 0.055, 0.1]} position={[0.15, 0.02, 0.08]} rotation={[0, 0, 0.56]} color={PALETTE.pearl} />
      <SculptBar args={[0.24, 0.045, 0.09]} position={[-0.24, -0.12, 0.08]} rotation={[0, 0, 0.58]} color={PALETTE.pearl} opacity={0.85} />
      <SculptBar args={[0.24, 0.045, 0.09]} position={[0.24, -0.12, 0.08]} rotation={[0, 0, -0.58]} color={PALETTE.pearl} opacity={0.85} />
    </group>
  );
}

function LovableBuilderMark() {
  return (
    <group>
      <SculptureBackplate width={0.78} height={0.52} color="#250B16" accent={PALETTE.lovablePink} />
      <SculptDisc radius={0.32} position={[-0.16, -0.02, 0.035]} scale={[1.04, 1.0, 1]} color={PALETTE.lovableBlue} opacity={0.9} />
      <SculptDisc radius={0.32} position={[0.07, 0.13, 0.045]} scale={[1.15, 0.82, 1]} color={PALETTE.lovablePink} opacity={0.84} />
      <SculptDisc radius={0.26} position={[0.2, 0.18, 0.055]} scale={[1.08, 0.8, 1]} color={PALETTE.lovableRed} opacity={0.8} />
      <SculptDisc radius={0.21} position={[0.1, 0.08, 0.07]} color={PALETTE.lovableOrange} opacity={0.92} />
      <SculptBar args={[0.34, 0.68, 0.12]} position={[-0.24, 0.04, 0.09]} color="#FFF2D1" opacity={0.84} />
      <SculptBar args={[0.64, 0.34, 0.12]} position={[0.02, -0.18, 0.1]} color="#FFF2D1" opacity={0.84} />
    </group>
  );
}

function NodeSculpture({ node, accent, sx, sy, sz }) {
  const plateWidth = sx * 0.58;
  const plateHeight = sy * 0.5;
  const baseColor = node.id === 'memory'
    ? '#071B2E'
    : node.id === 'builder'
      ? '#230A18'
      : '#2A0810';
  const iconScale = node.id === 'memory' ? 1.04 : node.id === 'builder' ? 0.92 : 0.9;

  return (
    <group position={[0, sy * 0.11, sz / 2 + 0.064]} scale={[iconScale, iconScale, iconScale]}>
      {node.id !== 'mailer' && node.id !== 'builder' ? (
        <SculptureBackplate width={plateWidth} height={plateHeight} color={baseColor} accent={accent} />
      ) : null}
      {node.id === 'memory' ? (
        <SupermemoryMark color="#D9E9FA" />
      ) : node.id === 'caller' ? (
        <PhoneMark color={accent} />
      ) : node.id === 'scraper' ? (
        <ScraperMark color={accent} />
      ) : node.id === 'mailer' ? (
        <AgentMailMark color={accent} />
      ) : node.id === 'builder' ? (
        <LovableBuilderMark />
      ) : null}
    </group>
  );
}

function SupermemoryLogo() {
  return (
    <svg viewBox="0 0 30 24" aria-hidden="true">
      <path d="M29.3388 9.46767H18.448V0.00146484H14.9293V10.2725C14.9293 11.3634 15.36 12.411 16.1254 13.183L25.018 22.151L27.506 19.6419L20.938 13.0183H29.3408V9.46975L29.3388 9.46767Z" />
      <path d="M1.82839 4.36056L8.39633 10.9842H-0.00646973V14.5328H10.8843V23.999H14.403V13.728C14.403 12.637 13.9723 11.5894 13.2069 10.8175L4.31635 1.85147L1.82839 4.36056Z" />
    </svg>
  );
}

function BrowserUseLogo() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <path d="M97.8916 39.0448C82.6177 33.1997 95.2199 10.8169 74.212 11.3849C48.5413 12.0793 8.31528 52.4518 12.4236 78.6851C14.4652 91.6755 24.6096 86.2218 29.3732 88.1154C32.5364 89.3652 36.2792 95.0083 40.3245 95.9047C22.4293 106.193 -0.556809 96.397 0.0102912 74.3423C0.829435 41.86 47.7474 -5.25386 81.1937 0.477571C99.8702 3.68414 102.189 23.5422 97.8916 39.0448Z" />
      <path d="M24.8115 57.7541L39.6068 71.7166C49.0332 80.1875 74.061 94.9706 85.403 84.9469C98.774 73.1306 70.495 32.3162 57.4769 25.802L68.9069 20.6639C86.7138 33.6796 113.783 75.9836 91.7294 94.4025C77.5014 106.282 54.5655 96.2204 41.0811 87.3707C30.8103 80.6294 15.9647 70.9591 24.8115 57.7415V57.7541Z" />
      <path d="M40.3373 4.75723C35.5485 4.88347 31.8055 11.1199 28.2895 12.2182C25.1642 13.1903 20.8414 10.5266 16.1408 14.0487C11.0495 17.8613 12.7891 36.0655 3.02233 40.5976C-2.98893 22.9362 0.75354 1.8789 22.4672 0.0736228C24.1433 -0.0652445 42.7822 1.17195 40.3373 4.74463V4.75723Z" />
      <path d="M76.1025 57.754C84.1175 71.0348 69.5871 86.2092 57.489 74.1025L76.1025 57.754Z" />
    </svg>
  );
}

function LovableLogo() {
  return (
    <svg viewBox="0 0 121 122" aria-hidden="true" className="scene-lovable-mark">
      <defs>
        <linearGradient id="scene-lovable-gradient" x1="40.453" x2="76.933" y1="21.433" y2="121.971" gradientUnits="userSpaceOnUse">
          <stop offset="0.025" stopColor="#FF8E63" />
          <stop offset="0.56" stopColor="#FF7EB0" />
          <stop offset="0.95" stopColor="#4B73FF" />
        </linearGradient>
      </defs>
      <path fill="url(#scene-lovable-gradient)" fillRule="evenodd" d="M36.069 0c19.92 0 36.068 16.155 36.068 36.084v13.713h12.004c19.92 0 36.069 16.156 36.069 36.084 0 19.928-16.149 36.083-36.069 36.083H0v-85.88C0 16.155 16.148 0 36.069 0Z" clipRule="evenodd" />
    </svg>
  );
}

function AgentMailLogo() {
  return (
    <svg viewBox="0 0 350 363" aria-hidden="true">
      <path d="M318.029 88.3407C196.474 115.33 153.48 115.321 33.9244 88.3271C30.6216 87.5814 27.1432 88.9727 25.3284 91.8313L1.24109 129.774C-1.76483 134.509 0.965276 140.798 6.46483 141.898C152.613 171.13 197.678 171.182 343.903 141.835C349.304 140.751 352.064 134.641 349.247 129.907L326.719 92.0479C324.95 89.0744 321.407 87.5907 318.029 88.3407Z" />
      <path d="M75.9931 246.6L149.939 311.655C151.973 313.444 151.633 316.969 149.281 318.48L119.141 337.84C117.283 339.034 114.951 338.412 113.933 336.452L70.1276 252.036C68.0779 248.086 72.7553 243.751 75.9931 246.6Z" />
      <path d="M274.025 246.6L200.08 311.655C198.046 313.444 198.385 316.969 200.737 318.48L230.877 337.84C232.736 339.034 235.068 338.412 236.085 336.452L279.891 252.036C281.941 248.086 277.263 243.751 274.025 246.6Z" />
      <path d="M138.75 198.472L152.436 192.983C155.238 191.918 157.77 191.918 158.574 191.918C164.115 192.126 169.564 192.232 175.009 192.235C180.454 192.232 185.904 192.126 191.444 191.918C192.248 191.918 194.78 191.918 197.583 192.983L211.269 198.472C212.645 199.025 214.082 199.382 215.544 199.448C218.585 199.587 221.733 199.464 224.63 198.811C225.706 198.568 226.728 198.103 227.704 197.545L243.046 188.784C244.81 187.777 246.726 187.138 248.697 186.9L258.276 185.5H263.556L256.679 234.22C255.957 238.31 254.25 242.328 250.443 245.834L187.376 299.258C184.555 301.648 181.107 302.942 177.562 302.942H172.457C168.911 302.942 165.464 301.648 162.643 299.258L99.5761 245.834C95.7684 242.328 94.0614 238.31 93.3393 234.22L86.4624 185.5H91.7429L101.322 186.9C103.293 187.138 105.208 187.777 106.972 188.784L122.314 197.545C123.291 198.103 124.313 198.568 125.389 198.811C128.286 199.464 131.434 199.587 134.474 199.448C135.936 199.382 137.373 199.025 138.75 198.472Z" />
      <path d="M102.47 0.847827C205.434 44.796 156.456 42.1015 248.434 1.63153C252.885 -1.09955 258.353 1.88915 259.419 7.69219L270.819 69.7893L263.592 71.8231C190.588 92.3069 165.244 92.0078 86.7576 71.7428L79.1971 69.7905L91.8401 6.91975C92.9559 1.3706 98.105 -1.55777 102.47 0.847827Z" />
    </svg>
  );
}

function AgentPhoneLogo() {
  return (
    <img
      src="https://agentphone.ai/logo.png"
      alt=""
      draggable="false"
      referrerPolicy="no-referrer"
    />
  );
}

function ProviderLogo({ id }) {
  if (id === 'memory') return <SupermemoryLogo />;
  if (id === 'caller') return <AgentPhoneLogo />;
  if (id === 'scraper') return <BrowserUseLogo />;
  if (id === 'mailer') return <AgentMailLogo />;
  if (id === 'builder') return <LovableLogo />;
  return null;
}

function LogoFace({ node, sx, sy, sz }) {
  return (
    <Html
      position={[0, sy * 0.16, sz / 2 + 0.102]}
      center
      distanceFactor={6}
      zIndexRange={[8, 0]}
      transform
      style={{ pointerEvents: 'none' }}
    >
      <div className={`scene-node-logo scene-node-logo-${node.id}`}>
        <ProviderLogo id={node.id} />
      </div>
    </Html>
  );
}

function NodeMesh({ node, state, count, isHovered, isSelected, onPointerEnter, onPointerLeave, onClick }) {
  const groupRef = useRef();
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

    // selected scale up
    const target = isSelected ? 1.06 : isHovered ? 1.04 : 1.0;
    groupRef.current.scale.x += (target - groupRef.current.scale.x) * Math.min(1, delta * 8);
    groupRef.current.scale.y += (target - groupRef.current.scale.y) * Math.min(1, delta * 8);
    groupRef.current.scale.z += (target - groupRef.current.scale.z) * Math.min(1, delta * 8);

  });

  const [sx, sy, sz] = node.size;
  const accent = errored ? PALETTE.brownRed : node.accent;
  const surfaceColor = errored
    ? PALETTE.brownRed
    : node.id === 'memory'
      ? '#173B57'
      : node.id === 'scraper'
        ? '#A85C21'
        : node.id === 'caller' || node.id === 'builder'
          ? '#A64C63'
          : '#8E5524';

  return (
    <group
      ref={groupRef}
      position={node.position}
      onPointerOver={(e) => { e.stopPropagation(); onPointerEnter?.(node.id); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { onPointerLeave?.(node.id); document.body.style.cursor = ''; }}
      onClick={(e) => { e.stopPropagation(); onClick?.(node.id); }}
    >
      {/* main solid box, styled as a physical module instead of a glow card */}
      <RoundedBox args={[sx, sy, sz]} radius={0.12} smoothness={4} castShadow receiveShadow>
        <meshStandardMaterial
          color={surfaceColor}
          roughness={0.72}
          metalness={0.08}
          emissive={accent}
          emissiveIntensity={running ? 0.24 : success ? 0.16 : 0.08}
        />
      </RoundedBox>

      <RoundedBox args={[sx * 0.94, 0.055, 0.08]} radius={0.03} smoothness={3} position={[0, sy / 2 - 0.08, sz / 2 + 0.035]}>
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={running ? 0.28 : 0.1} roughness={0.42} />
      </RoundedBox>
      <RoundedBox args={[sx * 0.64, 0.035, 0.07]} radius={0.02} smoothness={3} position={[0, -sy / 2 + 0.11, sz / 2 + 0.04]}>
        <meshStandardMaterial color={node.glow || accent} emissive={node.glow || accent} emissiveIntensity={running ? 0.32 : 0.1} roughness={0.48} />
      </RoundedBox>

      <LogoFace node={node} sx={sx} sy={sy} sz={sz} />

      {/* Compact label stays on the front lip so the raised provider mark remains visible. */}
      <Html
        position={[0, -sy / 2 - 0.18, sz / 2 + 0.13]}
        center
        distanceFactor={6}
        zIndexRange={[10, 0]}
        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
        transform
      >
        <div
          className="scene-node-label"
          onClick={(event) => {
            event.stopPropagation();
            onClick?.(node.id);
          }}
        >
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

function HubPlaque({ active, onClick }) {
  const groupRef = useRef();
  const ringRef = useRef();

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    groupRef.current.rotation.y = Math.sin(t * 0.24) * 0.05;
    if (ringRef.current) {
      ringRef.current.material.opacity = active ? 0.48 + 0.18 * Math.sin(t * 3) : 0.32;
    }
  });

  return (
    <group
      ref={groupRef}
      position={HUB_POSITION}
      onClick={(e) => { e.stopPropagation(); onClick?.('memory'); }}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    >
      <RoundedBox args={[1.9, 0.58, 0.22]} radius={0.09} smoothness={4} castShadow receiveShadow>
        <meshStandardMaterial
          color={PALETTE.cherryDeep}
          roughness={0.68}
          metalness={0.12}
          emissive={PALETTE.apricot}
          emissiveIntensity={active ? 0.18 : 0.08}
        />
      </RoundedBox>
      <lineSegments ref={ringRef}>
        <edgesGeometry args={[new THREE.BoxGeometry(1.96, 0.64, 0.26)]} />
        <lineBasicMaterial color={PALETTE.apricot} transparent opacity={0.34} />
      </lineSegments>
      <Html
        position={[0, 0.03, 0.16]}
        center
        distanceFactor={6}
        zIndexRange={[10, 0]}
        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
        transform
      >
        <div
          className="scene-hub-label"
          onClick={(event) => {
            event.stopPropagation();
            onClick?.('memory');
          }}
        >
          <span>Callan</span>
          <small>control center</small>
        </div>
      </Html>
    </group>
  );
}

function EdgeLine({ from, to, active }) {
  const ref = useRef();
  const curve = useMemo(() => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    mid.z += 0.34;
    mid.y += 0.08;
    return new THREE.QuadraticBezierCurve3(start, mid, end);
  }, [from, to]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.material.opacity = active
      ? 0.64 + 0.12 * Math.sin(t * 4)
      : 0.38;
  });

  return (
    <mesh ref={ref}>
      <tubeGeometry args={[curve, 44, active ? 0.026 : 0.017, 8, false]} />
      <meshBasicMaterial color={active ? PALETTE.apricot : PALETTE.pearl} transparent opacity={0.38} />
    </mesh>
  );
}

function SceneInside({
  hovered, setHovered, onSelect, selected, states, counters
}) {
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
        position={[0, -3.28, 0]}
        opacity={0.6}
        scale={14}
        blur={2.6}
        far={6}
        color={PALETTE.cherry}
      />

      <group>
        <HubPlaque
          active={Object.values(states).some((state) => state === 'running')}
          onClick={onSelect}
        />

        {SCENE_EDGES.map((toId) => {
          const to = nodeById[toId];
          const active = states[toId] === 'running';
          return (
            <EdgeLine
              key={`hub->${toId}`}
              from={HUB_POSITION}
              to={to.position}
              active={active}
            />
          );
        })}

        {SCENE_NODES.map((node) => (
          <Float
            key={node.id}
            speed={1.4}
            rotationIntensity={0}
            floatIntensity={0.14}
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
        target={[0, -0.56, 0]}
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
      camera={{ position: [0, -0.25, 12], fov: 42, near: 0.1, far: 100 }}
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
