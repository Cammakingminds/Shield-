import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// --- PROCEDURAL AUDIO ENGINE ---
class ShieldAudio {
    constructor() {
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            this.ctx = new AudioContext();

            // Master output with Dynamics Compressor to prevent painful clipping
            this.compressor = this.ctx.createDynamicsCompressor();
            this.compressor.threshold.value = -12;
            this.compressor.knee.value = 10;
            this.compressor.ratio.value = 8;
            this.compressor.attack.value = 0.003;
            this.compressor.release.value = 0.25;

            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.9; 
            
            // GLOBAL DISTORTION: Soft Clipping curve for overdriven heat and damage
            this.distCurve = new Float32Array(4096);
            let k = 150; 
            for (let i = 0; i < 4096; i++) {
                let x = (i / 4096) * 2 - 1;
                this.distCurve[i] = (3 + k) * x * 20 * (Math.PI / 180) / (Math.PI + k * Math.abs(x));
            }
            this.masterDistortion = this.ctx.createWaveShaper();
            this.masterDistortion.curve = this.distCurve;
            this.masterDistortion.oversample = '4x';
            
            this.dryGain = this.ctx.createGain();
            this.wetGain = this.ctx.createGain();
            this.wetGain.gain.value = 0;
            
            this.masterGain.connect(this.dryGain);
            this.masterGain.connect(this.masterDistortion);
            this.masterDistortion.connect(this.wetGain);
            
            this.dryGain.connect(this.compressor);
            this.wetGain.connect(this.compressor);
            this.compressor.connect(this.ctx.destination);

            // Generate White Noise Buffer for Holes & Surface
            const sampleRate = Math.floor(this.ctx.sampleRate);
            const bufferSize = sampleRate * 2; 
            this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
            const output = this.noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                output[i] = Math.random() * 2 - 1;
            }

            // Generate Sparse Impulse Buffer for Arcs (Popping)
            this.snapBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
            const snapData = this.snapBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                // INCREASED: Doubled the physical density of the raw arc spikes (0.2% chance instead of 0.1%)
                snapData[i] = Math.random() > 0.998 ? (Math.random() > 0.5 ? 1 : -1) : 0;
            }

            // Floating Point Error Bitcrush Curve
            const steps = 4; // Extreme digital artifacting
            this.crushCurve = new Float32Array(4096);
            for (let j = 0; j < 4096; j++) {
                let x = (j / 4096) * 2 - 1;
                this.crushCurve[j] = Math.round(x * steps) / steps;
            }

            // 4. Surface Drag & Ambient Arc Voice
            this.surfaceNoise = this.ctx.createBufferSource();
            this.surfaceNoise.buffer = this.noiseBuffer;
            this.surfaceNoise.loop = true;

            this.surfaceSnap = this.ctx.createBufferSource();
            this.surfaceSnap.buffer = this.snapBuffer;
            this.surfaceSnap.loop = true;

            // NEW: Singing resonant filter for damaged surface and touch
            this.surfaceFilter = this.ctx.createBiquadFilter();
            this.surfaceFilter.type = 'bandpass';
            this.surfaceFilter.Q.value = 20.0;

            // LFO to make the singing chaotic and electrical
            this.surfaceLfo = this.ctx.createOscillator();
            this.surfaceLfo.type = 'sawtooth';
            this.surfaceLfo.frequency.value = 5;
            this.surfaceMod = this.ctx.createGain();
            this.surfaceMod.gain.value = 0;
            this.surfaceLfo.connect(this.surfaceMod);
            this.surfaceMod.connect(this.surfaceFilter.frequency);
            this.surfaceLfo.start();

            this.surfaceCrush = this.ctx.createWaveShaper();
            this.surfaceCrush.curve = this.crushCurve;

            this.surfaceGain = this.ctx.createGain();
            this.surfaceGain.gain.value = 0;

            // A tiny bit of continuous noise excites the resonant singing
            this.surfaceNoiseGain = this.ctx.createGain();
            this.surfaceNoiseGain.gain.value = 0.02; 

            this.surfaceSnapGain = this.ctx.createGain();
            // INCREASED: Touches are now much louder and punchier so they are plainly audible
            this.surfaceSnapGain.gain.value = 25.0; 

            // --- NEW: GLOBAL SHIMMER LAYER ---
            this.surfaceShimmerOsc = this.ctx.createOscillator();
            this.surfaceShimmerOsc.type = 'sine';
            this.surfaceShimmerGain = this.ctx.createGain();
            this.surfaceShimmerGain.gain.value = 0;
            this.surfaceShimmerOsc.connect(this.surfaceShimmerGain);
            
            // UNMASKED: Route shimmer directly to master gain to stop it from crushing the arcs
            this.surfaceShimmerGain.connect(this.surfaceGain);
            this.surfaceShimmerOsc.start();

            this.surfaceNoise.connect(this.surfaceNoiseGain);
            this.surfaceSnap.connect(this.surfaceSnapGain);
            
            this.surfaceNoiseGain.connect(this.surfaceFilter);
            // UNMASKED: Touch arcs bypass the muffled filter and slam straight into the bitcrusher
            this.surfaceSnapGain.connect(this.surfaceCrush);
            
            this.surfaceFilter.connect(this.surfaceCrush);
            this.surfaceCrush.connect(this.surfaceGain);
            this.surfaceGain.connect(this.masterGain);

            this.surfaceNoise.start();
            this.surfaceSnap.start();

            // 5. Polyphonic Static Hole Voices
            this.holeVoices = [];
            for (let i = 0; i < 8; i++) {
                let noiseSrc = this.ctx.createBufferSource();
                noiseSrc.buffer = this.noiseBuffer;
                noiseSrc.loop = true;
                
                let shimmerFilter = this.ctx.createBiquadFilter();
                shimmerFilter.type = 'bandpass';
                shimmerFilter.Q.value = 12.0; 
                
                let shimmerLfo = this.ctx.createOscillator();
                shimmerLfo.type = 'sine';
                shimmerLfo.frequency.value = 15;
                
                let shimmerMod = this.ctx.createGain();
                shimmerMod.gain.value = 500;
                
                shimmerLfo.connect(shimmerMod);
                shimmerMod.connect(shimmerFilter.frequency);

                let snapSrc = this.ctx.createBufferSource();
                snapSrc.buffer = this.snapBuffer;
                snapSrc.loop = true;

                let bitcrush = this.ctx.createWaveShaper();
                bitcrush.curve = this.crushCurve;

                let gain = this.ctx.createGain();
                gain.gain.value = 0;
                
                let pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : this.ctx.createGain();

                // --- NEW: HOLE SHIMMER TONE ---
                // Adds a distorted, high-pitched glassy layer to the holes based on severity
                let holeShimmerOsc = this.ctx.createOscillator();
                holeShimmerOsc.type = 'sine';
                let holeShimmerGain = this.ctx.createGain();
                holeShimmerGain.gain.value = 0;
                
                let shimmerOscMod = this.ctx.createGain();
                shimmerOscMod.gain.value = 0;
                shimmerLfo.connect(shimmerOscMod);
                shimmerOscMod.connect(holeShimmerOsc.frequency); // FM modulation
                
                holeShimmerOsc.connect(holeShimmerGain);
                
                // UNMASKED: Bypasses the bitcrush so the loud singing doesn't squash the crackling
                holeShimmerGain.connect(gain); 
                holeShimmerOsc.start();

                // Mute the continuous white noise hiss
                let noiseGain = this.ctx.createGain();
                noiseGain.gain.value = 0.0;
                
                // INCREASED: Massively boost the raw snaps for the holes to hit the distortion harder
                let snapGain = this.ctx.createGain();
                snapGain.gain.value = 40.0;

                noiseSrc.connect(noiseGain);
                noiseGain.connect(shimmerFilter);
                shimmerFilter.connect(bitcrush);
                
                // Raw arc snaps bypass the filter and slam straight into the bitcrusher for maximum violence
                snapSrc.connect(snapGain);
                snapGain.connect(bitcrush);
                
                bitcrush.connect(gain);
                gain.connect(pan);
                pan.connect(this.masterGain);
                
                noiseSrc.start();
                snapSrc.start();
                shimmerLfo.start();

                this.holeVoices.push({ 
                    noiseSrc, snapSrc, shimmerFilter, shimmerLfo, shimmerMod, bitcrush, gain, pan,
                    holeShimmerOsc, holeShimmerGain, shimmerOscMod
                });
            }

            this.ctx.resume();
            this.initialized = true;
        } catch (e) {
            console.error("Shield audio engine failed to initialize:", e);
            this.initialized = false; 
        }
    }

    playTapSound() {
        if (!this.initialized || this.ctx.state !== 'running') return;
        this.tapSpike = 1.0; 
    }

    update(tension, stress, holes, arcPower, touchSustain, touchPan, touchDamage, damageSpike, ambientDamage) {
        if (!this.initialized || this.ctx.state !== 'running') return;
        
        tension = isNaN(tension) ? 0 : tension;
        stress = isNaN(stress) ? 0 : stress;
        arcPower = isNaN(arcPower) ? 0 : arcPower;
        touchSustain = isNaN(touchSustain) ? 0 : touchSustain;
        touchPan = isNaN(touchPan) ? 0 : touchPan;
        touchDamage = isNaN(touchDamage) ? 0 : touchDamage;
        damageSpike = isNaN(damageSpike) ? 0 : damageSpike;
        ambientDamage = isNaN(ambientDamage) ? 0 : ambientDamage;

        const now = this.ctx.currentTime + 0.01; 
        
        this.tapSpike = (this.tapSpike || 0) * 0.80; 

        let surge = Math.max(0, Math.min(1.0, arcPower / 25.0));

        // SINGING SURFACE: Touching or global unbroken damage makes the entire surface 'sing' chaotically
        let singFreq = 150 + (ambientDamage * 3500) + (touchDamage * 4500) + (this.tapSpike * 2000) + (Math.random() * 500);
        
        // MORE REAL-TIME: Tightened time constants from 0.05 to 0.02 to eliminate audio latency
        this.surfaceFilter.frequency.setTargetAtTime(Math.min(8000, singFreq), now, 0.02);
        
        // DECREASED Q: Letting the broad-spectrum crackles pass through so touch is much more audible
        this.surfaceFilter.Q.setTargetAtTime(5.0 + (stress * 15.0) + (ambientDamage * 10.0), now, 0.02);

        this.surfaceLfo.frequency.setTargetAtTime(2 + (stress * 40) + (ambientDamage * 30), now, 0.02);
        this.surfaceMod.gain.setTargetAtTime(singFreq * (0.2 + stress * 0.8), now, 0.02);

        // --- NEW SHIMMER LAYER ---
        // REVERSED PITCH CURVE: High pitch at first (healthy), rapidly decaying into a low roar as damage accumulates
        let surfacePitchCurve = Math.pow(Math.max(0, 1.0 - ambientDamage - (stress * 0.5)), 2.0);
        let shimmerPitch = 200 + (8000 * surfacePitchCurve) - (touchDamage * 1000);
        this.surfaceShimmerOsc.frequency.setTargetAtTime(Math.max(200, Math.min(12000, shimmerPitch)), now, 0.02);
        
        // SHARP INCREASE BEFORE HOLE: Massive volume spike as ambient damage reaches the breaking threshold
        let preHoleSpike = Math.pow(ambientDamage, 3.0) * 3.0;

        let surfaceShimmerVol = (ambientDamage * 0.6) + (touchDamage * 0.4) + (stress * 0.5) + (preHoleSpike * 0.3);
        this.surfaceShimmerGain.gain.setTargetAtTime(Math.min(1.0, surfaceShimmerVol), now, 0.04);

        let touchIntensity = touchSustain > 0.01 ? (0.25 + (touchDamage * 0.5)) * touchSustain : 0;
        let ambientIntensity = ambientDamage * 0.35; 
        
        // APPLY SPIKE: Violent surge in crackling volume right before the shield breaks
        let surfaceTargetGain = Math.min(1.5, touchIntensity + ambientIntensity + (surge * 0.1) + preHoleSpike);
        this.surfaceGain.gain.setTargetAtTime(surfaceTargetGain * (1.0 + stress * 0.5), now, 0.02);

        // APPLY SPIKE: Massive surge in crackling particle density right before the break
        let surfaceSnapDensity = Math.max(0.05, (ambientDamage * 10.0) + (surge * 15.0) + (touchSustain * (5.0 + (touchDamage * 30.0))) + (preHoleSpike * 20.0));
        this.surfaceSnap.playbackRate.setTargetAtTime(surfaceSnapDensity, now, 0.02);

        for (let i = 0; i < this.holeVoices.length; i++) {
            let voice = this.holeVoices[i];
            if (i < holes.length) {
                let hole = holes[i];

                let sizeFactor = Math.max(0, Math.min(1.0, hole.size / 40.0)); 
                let irreg = hole.irregularity || 0;
                let smoothSize = sizeFactor; 

                // WARBLING STATIC PITCH: Driven by Size and Topographic Irregularity
                let noisePitch = 0.2 + (smoothSize * 2.5) + (irreg * 1.5);
                voice.noiseSrc.playbackRate.setTargetAtTime(noisePitch, now, 0.02);

                let holeFreq = 250 + (smoothSize * 6500) + (irreg * 2000);
                holeFreq += (stress * 800 * (i % 2 === 0 ? 1 : -1));
                holeFreq = Math.min(8000, Math.max(100, holeFreq));

                voice.shimmerFilter.frequency.setTargetAtTime(holeFreq, now, 0.02);

                let currentQ = Math.max(1.0, 8.0 + (irreg * 15.0) - (stress * 4.0));
                voice.shimmerFilter.Q.setTargetAtTime(currentQ, now, 0.02);

                // CHAOTIC INSTABILITY: Warble speed goes berserk based on global shield health (stress)
                let shimmerSpeed = 5 + (stress * 150) + (smoothSize * 20.0) + (irreg * 50.0);
                voice.shimmerLfo.frequency.setTargetAtTime(shimmerSpeed, now, 0.02);
                voice.shimmerMod.gain.setTargetAtTime(holeFreq * (0.3 + stress * 1.2 + irreg * 0.8), now, 0.02);

                // --- NEW HOLE SHIMMER TONE ---
                // REVERSED PITCH CURVE: High pitch right when hole forms, rapidly dropping into a low roar as it expands
                let holePitchCurve = Math.pow(Math.max(0, 1.0 - smoothSize), 2.0);
                let holeShimmerPitch = 200 + (8000 * holePitchCurve) - (irreg * 1500);
                voice.holeShimmerOsc.frequency.setTargetAtTime(Math.max(200, Math.min(12000, holeShimmerPitch)), now, 0.02);
                voice.shimmerOscMod.gain.setTargetAtTime((smoothSize * 4000) + (irreg * 3000), now, 0.02); // FM distortion depth tied to hole size
                
                // SHARP INCREASE AFTER HOLE: Massive volume spike instantly when a new tiny hole opens
                let postHoleSpike = Math.max(0, 1.0 - (smoothSize * 15.0)) * 3.0;

                let holeShimmerVol = (0.02 + (stress * 0.8) + (irreg * 0.3)) * (0.2 + smoothSize * 0.8) + (postHoleSpike * 0.2);
                voice.holeShimmerGain.gain.setTargetAtTime(Math.min(0.8, holeShimmerVol), now, 0.02);

                // APPLY SPIKE: Dense flurry of crackling sparks immediately after breach
                let popDensity = 0.8 + (stress * 30.0) + (smoothSize * 18.0) + (irreg * 12.0) + (surge * 8.0) + (postHoleSpike * 20.0);
                voice.snapSrc.playbackRate.setTargetAtTime(popDensity, now, 0.02);

                // APPLY SPIKE: Brutal volume boost on the new, raw exposed edges
                let targetGain = Math.min(4.0, 0.2 + smoothSize * 2.0 + irreg * 0.8 + postHoleSpike);
                targetGain *= (1.0 + stress * 4.0); 

                voice.gain.gain.setTargetAtTime(targetGain, now, 0.02);

                if (voice.pan && voice.pan.pan) {
                    let panVal = Math.max(-1, Math.min(1, hole.x / 420));
                    voice.pan.pan.setTargetAtTime(panVal, now, 0.04);
                }
            } else {
                voice.gain.gain.setTargetAtTime(0, now, 0.05);
                voice.holeShimmerGain.gain.setTargetAtTime(0, now, 0.05);
            }
        }
    }
}

class HexShieldSphere {
    constructor(container) {
        this.container = container;
        
        this.audio = new ShieldAudio();

        this.config = {
            sphereRadius: 420,
            sphereDetail: 24, 
            hexSize: 15,
            hexGap: 0.98,
            breakThreshold: 10.0,
            damageRadius: 3.0,   
            damagePerFrame: 0.85, 
            baseRepairRate: 0.25, 
            
            colorHealthyBase: new THREE.Color(0x002266), 
            colorHealthyGlow: new THREE.Color(0x22bbff), 
            colorHealthyPeak: new THREE.Color(0xffffff), 
            
            colorMidBase: new THREE.Color(0x441100),     
            colorMidGlow: new THREE.Color(0xff6600),     
            colorMidPeak: new THREE.Color(0xffcc00),     
            
            colorStressedBase: new THREE.Color(0x220000), 
            colorStressedGlow: new THREE.Color(0xaa0000), 
            colorStressedPeak: new THREE.Color(0xff2200)  
        };

        this.grid = new Map();
        this.pointers = new Map();
        this.activeTouches = new Set();
        this.globalTension = 0;
        this.shieldStress = 0;
        this.holeAudioData = [];
        this.currentArcPower = 0;
        
        this.shieldVelocity = { x: 0, y: 0 };
        this.shieldDragPointerId = null; 
        this.dragLast = { x: 0, y: 0 };
        
        this.touchSustain = 0;
        this.lastTouchPan = 0;
        this.lastTouchDamage = 0;

        this.initThree();
        this.generateSphereGrid();
        this.setupInputs();
        
        this.loop = this.loop.bind(this);
        document.getElementById('loading').style.display = 'none';
        requestAnimationFrame(this.loop);
    }

    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);
        
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 3000);
        this.camera.position.set(0, 0, 1300);
        
        this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.container.appendChild(this.renderer.domElement);

        const renderScene = new RenderPass(this.scene, this.camera);
        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            1.25, 
            0.35, 
            1.0   
        );
        
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(renderScene);
        this.composer.addPass(bloomPass);

        this.shieldGroup = new THREE.Group();
        this.scene.add(this.shieldGroup);
        
        this.raycaster = new THREE.Raycaster();
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.composer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    generateSphereGrid() {
        if (this.instancedMesh) { this.shieldGroup.remove(this.instancedMesh); this.instancedMesh.dispose(); }
        this.grid.clear();

        let baseGeo = new THREE.IcosahedronGeometry(this.config.sphereRadius, this.config.sphereDetail);
        baseGeo.deleteAttribute('normal');
        baseGeo.deleteAttribute('uv');
        baseGeo = BufferGeometryUtils.mergeVertices(baseGeo);
        baseGeo.computeVertexNormals();

        const positions = baseGeo.attributes.position;
        const normals = baseGeo.attributes.normal;
        const indices = baseGeo.index.array;

        const adjacency = new Map();
        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i], b = indices[i+1], c = indices[i+2];
            if(!adjacency.has(a)) adjacency.set(a, new Set());
            if(!adjacency.has(b)) adjacency.set(b, new Set());
            if(!adjacency.has(c)) adjacency.set(c, new Set());
            adjacency.get(a).add(b).add(c);
            adjacency.get(b).add(a).add(c);
            adjacency.get(c).add(a).add(b);
        }

        let pA = new THREE.Vector3(), pB = new THREE.Vector3();
        pA.fromBufferAttribute(positions, 0);
        pB.fromBufferAttribute(positions, Array.from(adjacency.get(0))[0]);
        const hexRadius = pA.distanceTo(pB) * 0.55; 

        const flatHexGeo = new THREE.CircleGeometry(hexRadius, 6);
        
        const instancedOpacity = new Float32Array(positions.count);
        flatHexGeo.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(instancedOpacity, 1));

        const shieldMaterial = new THREE.MeshBasicMaterial({ 
            color: 0xffffff, 
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.85, 
            depthWrite: false
        });

        shieldMaterial.defines = { USE_UV: '' };

        shieldMaterial.onBeforeCompile = (shader) => {
            shader.vertexShader = `
                attribute float instanceOpacity;
                varying float vOpacity;
                ${shader.vertexShader}
            `.replace(
                `void main() {`,
                `void main() {
                    vOpacity = instanceOpacity;
                `
            );

            shader.fragmentShader = `
                varying float vOpacity;
                ${shader.fragmentShader}
            `.replace(
                `#include <color_fragment>`,
                `#include <color_fragment>
                vec2 p = vUv * 2.0 - 1.0;
                vec2 q = abs(p);
                float d = max(q.x + q.y * 0.577350269, q.y * 1.154700538); 
                float border = smoothstep(0.85, 0.98, d);
                float perimeterBoost = mix(1.0, 0.5, vOpacity);
                float cellAlpha = max(border * perimeterBoost, vOpacity);
                diffuseColor.a *= cellAlpha;
                `
            );
        };

        this.instancedMesh = new THREE.InstancedMesh(flatHexGeo, shieldMaterial, positions.count);
        this.shieldGroup.add(this.instancedMesh);

        const dummy = new THREE.Object3D();
        const up = new THREE.Vector3(0, 0, 1);
        
        const opacityAttr = this.instancedMesh.geometry.attributes.instanceOpacity;

        for (let i = 0; i < positions.count; i++) {
            pA.fromBufferAttribute(positions, i);
            let norm = new THREE.Vector3().fromBufferAttribute(normals, i);
            
            dummy.position.copy(pA);
            dummy.quaternion.setFromUnitVectors(up, norm);
            dummy.rotateZ((Math.PI / 3) * (i % 2)); 
            
            dummy.scale.set(this.config.hexGap, this.config.hexGap, 1);
            dummy.updateMatrix();
            
            this.instancedMesh.setMatrixAt(i, dummy.matrix);
            this.instancedMesh.setColorAt(i, this.config.colorHealthyBase);
            
            opacityAttr.setX(i, 0.0);

            this.grid.set(i, {
                id: i, 
                x: pA.x, y: pA.y, z: pA.z,
                neighbors: Array.from(adjacency.get(i)),
                damage: 0, isBroken: false, rebuildProgress: 0, brightness: 0, conduitPath: 0, localHoleSize: 0, isHoleRim: false, healGlow: 0, holdSuppression: 0
            });
        }
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        this.instancedMesh.instanceColor.needsUpdate = true;
        opacityAttr.needsUpdate = true;
    }

    getNeighbors(id) {
        const hex = this.grid.get(id);
        return hex ? hex.neighbors.map(nId => this.grid.get(nId)) : [];
    }

    getClosestHex(worldPoint) {
        let localPoint = worldPoint.clone();
        this.shieldGroup.worldToLocal(localPoint);
        
        let closest = null, minDist = Infinity;
        for (let hex of this.grid.values()) {
            let dx = hex.x - localPoint.x;
            let dy = hex.y - localPoint.y;
            let dz = hex.z - localPoint.z;
            let distSq = dx*dx + dy*dy + dz*dz;
            if (distSq < minDist) { minDist = distSq; closest = hex; }
        }
        return closest;
    }

    setupInputs() {
        const unlockAudio = () => {
            if (!this.audio.initialized) this.audio.init();
            if (this.audio.ctx && this.audio.ctx.state === 'suspended') {
                this.audio.ctx.resume();
            }
        };
        window.addEventListener('pointerdown', unlockAudio, { passive: true });
        window.addEventListener('touchstart', unlockAudio, { passive: true });
        window.addEventListener('click', unlockAudio, { passive: true });
        window.addEventListener('keydown', unlockAudio, { passive: true });

        const getIntersection = (clientX, clientY) => {
            const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
            this.raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, this.camera);
            const mathSphere = new THREE.Sphere(this.shieldGroup.position, this.config.sphereRadius + 15);
            const target = new THREE.Vector3();
            
            if (this.raycaster.ray.intersectSphere(mathSphere, target)) {
                return target.clone();
            }
            return null;
        };

        const onDown = (e) => { 
            e.preventDefault();
            const p = getIntersection(e.clientX, e.clientY); 
            if (p) {
                this.pointers.set(e.pointerId, p);
                if (this.shieldDragPointerId === e.pointerId) this.shieldDragPointerId = null;
                
                this.audio.playTapSound();

            } else {
                if (this.shieldDragPointerId === null) {
                    this.shieldDragPointerId = e.pointerId;
                    this.dragLast = { x: e.clientX, y: e.clientY };
                }
            }
        };

        const onMove = (e) => { 
            e.preventDefault();
            if (this.shieldDragPointerId === e.pointerId) {
                const dx = e.clientX - this.dragLast.x;
                const dy = e.clientY - this.dragLast.y;
                this.shieldVelocity.y = dx * 0.003;
                this.shieldVelocity.x = dy * 0.003;
                this.dragLast = { x: e.clientX, y: e.clientY };
            } else if (this.pointers.has(e.pointerId)) { 
                const p = getIntersection(e.clientX, e.clientY); 
                if (p) this.pointers.set(e.pointerId, p); 
            } 
        };

        const onUp = (e) => { 
            e.preventDefault();
            this.pointers.delete(e.pointerId); 
            if (this.shieldDragPointerId === e.pointerId) {
                this.shieldDragPointerId = null;
            }
        };

        const dom = this.renderer.domElement;
        dom.addEventListener('pointerdown', onDown);
        window.addEventListener('pointermove', onMove, {passive: false});
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        window.addEventListener('pointerleave', onUp);
    }

    applyInteractionDamage() {
        this.activeTouches.clear();
        for (let [id, pos] of this.pointers) {
            const closest = this.getClosestHex(pos);
            if (closest) {
                this.distributeDamage(closest.id, this.config.damagePerFrame);
                this.activeTouches.add(closest.id);
            }
        }
    }

    distributeDamage(centerId, amount) {
        const centerHex = this.grid.get(centerId);
        if (!centerHex) return;
        let queue = [{hex: centerHex, dist: 0}];
        let visited = new Set([centerId]);
        let iterations = 0; 

        while (queue.length > 0 && iterations < 1500) {
            iterations++;
            let {hex, dist} = queue.shift();
            let noise = dist === 0 ? 1.0 : (0.5 + Math.random() * 1.0);
            const attenuation = Math.max(0, 1 - (dist / this.config.damageRadius));
            
            hex.holdSuppression = Math.min(1.0, (hex.holdSuppression || 0) + attenuation * 0.35);

            let fragility = hex.isHoleRim ? 6.0 : 1.0;

            const appliedDamage = amount * (attenuation * attenuation) * noise * fragility;
            
            if (!hex.isBroken) {
                hex.damage += appliedDamage;
                if (hex.damage >= this.config.breakThreshold) {
                    hex.isBroken = true; hex.damage = 0; hex.rebuildProgress = 0;
                }
            }
            if (dist < this.config.damageRadius) {
                for (let n of this.getNeighbors(hex.id)) {
                    if (!visited.has(n.id)) {
                        visited.add(n.id);
                        queue.push({hex: n, dist: dist + 1});
                    }
                }
            }
        }
    }

    updateLogic() {
        let brokenCells = [];
        let intactCells = [];
        for (let hex of this.grid.values()) {
            if (hex.holdSuppression !== undefined) hex.holdSuppression *= 0.80; 

            if (hex.isBroken) brokenCells.push(hex);
            else intactCells.push(hex);
            hex.localHoleSize = 0; 
            hex.isHoleRim = false;
        }
        
        let unvisitedBroken = new Set(brokenCells);
        let holeSizesMap = new Map();
        let holeClusters = []; 

        for (let bHex of brokenCells) {
            if (unvisitedBroken.has(bHex)) {
                let cluster = [];
                let queue = [bHex];
                unvisitedBroken.delete(bHex);
                while(queue.length > 0) {
                    let curr = queue.shift(); cluster.push(curr);
                    for (let n of this.getNeighbors(curr.id)) {
                        if (n.isBroken && unvisitedBroken.has(n)) { unvisitedBroken.delete(n); queue.push(n); }
                    }
                }
                for (let c of cluster) holeSizesMap.set(c, cluster.length);
                holeClusters.push(cluster);
            }
        }

        this.holeAudioData = [];
        let hexToAudioData = new Map();
        for (let cluster of holeClusters) {
            let avgX = 0;
            let perimeterIntact = 0;
            let effectiveSize = 0; 
            
            for (let hex of cluster) {
                avgX += hex.x;
                
                // AUDIO SPREAD: As the hole physically heals, it smoothly shrinks in audio footprint
                effectiveSize += (1.0 - hex.rebuildProgress);
                
                for (let n of this.getNeighbors(hex.id)) {
                    if (!n.isBroken) perimeterIntact++;
                }
            }
            
            // TOPOLOGICAL IRREGULARITY: Compare actual jagged perimeter to an ideal circle-ish cluster
            let idealPerimeter = Math.sqrt(cluster.length) * 5; 
            let irregularity = Math.max(0, Math.min(1.0, (perimeterIntact / idealPerimeter) - 0.7));

            let audioObj = {
                size: Math.max(0.01, effectiveSize), // Feed the smoothly decaying size to the synthesizer
                x: avgX / cluster.length,
                healSpike: 0,
                irregularity: irregularity
            };
            this.holeAudioData.push(audioObj);
            for (let hex of cluster) {
                hexToAudioData.set(hex.id, audioObj);
            }
        }
        this.holeAudioData.sort((a,b) => b.size - a.size);

        let brokenCellThinness = new Map();
        for (let brokenHex of brokenCells) {
            let localIntact = 0;
            for (let n of this.getNeighbors(brokenHex.id)) {
                if (!n.isBroken) localIntact += 2.5; 
                for (let nn of this.getNeighbors(n.id)) {
                    if (!nn.isBroken) localIntact += 1.0; 
                }
            }
            let thinness = Math.max(0.5, Math.pow(localIntact / 10.0, 1.8));
            brokenCellThinness.set(brokenHex.id, thinness);
        }

        let unvisitedIntact = new Set(intactCells);
        let intactClusters = [];
        for (let iHex of intactCells) {
            if (unvisitedIntact.has(iHex)) {
                let cluster = [];
                let queue = [iHex];
                unvisitedIntact.delete(iHex);
                while(queue.length > 0) {
                    let curr = queue.shift(); cluster.push(curr);
                    for (let n of this.getNeighbors(curr.id)) {
                        if (!n.isBroken && unvisitedIntact.has(n)) { unvisitedIntact.delete(n); queue.push(n); }
                    }
                }
                intactClusters.push(cluster);
            }
        }
        
        let mainlandSet = new Set();
        if (intactClusters.length > 0) {
            intactClusters.sort((a, b) => b.length - a.length);
            for (let hex of intactClusters[0]) mainlandSet.add(hex.id);
        }

        let totalGridDamage = 0;
        let ambientScore = 0;
        let ambientCapacity = 0;
        
        for (let hex of this.grid.values()) {
            if (hex.isBroken) {
                totalGridDamage += this.config.breakThreshold;
                
                // AUDIO CROSS-FADE: Partially healed holes gradually contribute to the singing surface
                // instead of snapping to 100% instantly when they finish healing.
                if (hex.rebuildProgress > 0) {
                    ambientScore += hex.rebuildProgress * (this.config.breakThreshold - 0.1);
                    ambientCapacity += hex.rebuildProgress * this.config.breakThreshold;
                }
            } else {
                totalGridDamage += hex.damage;
                ambientScore += hex.damage;
                ambientCapacity += this.config.breakThreshold;
            }
        }
        
        // Track ambient unbroken damage to make the glowing surface "sing" chaotically
        let targetAmbient = ambientCapacity > 0 ? Math.max(0, Math.min(1.0, ambientScore / (ambientCapacity * 0.35))) : 0;
        this.ambientDamage = (this.ambientDamage || 0) * 0.9 + targetAmbient * 0.1; // Smooth out the singing envelope

        // --- NEW: DAMAGE DELTA TRACKING FOR AUDIO SPIKES ---
        let previousDamage = this.totalGridDamage || totalGridDamage;
        this.totalGridDamage = totalGridDamage;
        this.frameDamageDelta = Math.max(0, totalGridDamage - previousDamage);
        
        let maxPossibleDamage = this.grid.size * this.config.breakThreshold;
        let trueDamageRatio = totalGridDamage / maxPossibleDamage;
        
        let targetTension = Math.max(0, Math.min(3.0, trueDamageRatio * 5.0)); 
        
        this.globalTension = (this.globalTension === undefined || isNaN(this.globalTension)) ? 
            targetTension : (this.globalTension * 0.95 + targetTension * 0.05);

        let targetStress = Math.max(0, Math.min(1.0, trueDamageRatio * 3.5)); 
        
        this.shieldStress = (this.shieldStress === undefined || isNaN(this.shieldStress)) ? 
            targetStress : (this.shieldStress * 0.98 + targetStress * 0.02);

        let healthRatio = Math.max(0, 1.0 - trueDamageRatio);
        let powerSupplyEfficiency = Math.max(0.65, 1.0 - (this.globalTension * 0.4));
        let dynamicRepairBudget = 0.4 + (healthRatio * 0.4); 

        for (let step = 0; step < 2; step++) {
            let requiredDamages = new Map();
            let nextHoleSizes = new Map();
            for (let hex of this.grid.values()) {
                if (hex.isBroken) {
                    let hSize = holeSizesMap.get(hex) || 1; 
                    for (let n of this.getNeighbors(hex.id)) {
                        if (!n.isBroken) {
                            requiredDamages.set(n.id, Math.max(requiredDamages.get(n.id) || 0, this.config.breakThreshold * 0.85));
                            nextHoleSizes.set(n.id, Math.max(nextHoleSizes.get(n.id) || 0, hSize));
                        }
                    }
                } 
                else if (hex.damage > 0) {
                    let hSize = hex.localHoleSize || 1; 
                    
                    let spatialResistance = (Math.sin(hex.x * 12.9898 + hex.y * 78.233) * 43758.5453) % 1;
                    spatialResistance = Math.abs(spatialResistance) * 0.15; 
                    
                    let sizeBonus = Math.min(0.5, hSize * 0.02); 
                    let retention = 0.62 + sizeBonus - (this.globalTension * 0.22) - spatialResistance;
                    retention = Math.max(0.1, Math.min(0.94, retention));
                    
                    for (let n of this.getNeighbors(hex.id)) {
                        if (!n.isBroken) {
                            let requiredGradient = hex.damage * retention; 
                            if (n.damage < requiredGradient) {
                                requiredDamages.set(n.id, Math.max(requiredDamages.get(n.id) || 0, requiredGradient));
                                nextHoleSizes.set(n.id, Math.max(nextHoleSizes.get(n.id) || 0, hSize));
                            }
                        }
                    }
                }
            }
            for (let [hexId, reqDam] of requiredDamages) {
                let hex = this.grid.get(hexId);
                hex.damage = Math.max(hex.damage, reqDam);
            }
            for (let [hexId, hSize] of nextHoleSizes) {
                let hex = this.grid.get(hexId);
                hex.localHoleSize = Math.max(hex.localHoleSize, hSize);
            }
        }

        let powerSources = [];
        for (let hex of this.grid.values()) {
            if (hex.conduitPath !== undefined) hex.conduitPath *= 0.80; 
            hex.brightness *= 0.88; 
            hex.healGlow *= 0.94;   
            hex.isSource = false; 

            if (!hex.isBroken) {
                let isMainland = mainlandSet.has(hex.id);
                let intactTouches = 0;
                let neighbors = this.getNeighbors(hex.id);
                for (let n of neighbors) if (!n.isBroken) intactTouches++;
                let brokenTouches = neighbors.length - intactTouches;
                
                if (!isMainland) {
                    hex.damage += 0.20 + Math.random() * 0.15; 
                    if (hex.damage >= this.config.breakThreshold) {
                        hex.isBroken = true; hex.damage = 0; hex.rebuildProgress = 0; continue; 
                    }
                } else if (brokenTouches >= 3) {
                    hex.damage += Math.pow(brokenTouches - 2.0, 1.8) * 0.045;
                    if (hex.damage >= this.config.breakThreshold) {
                        hex.isBroken = true; hex.damage = 0; hex.rebuildProgress = 0; continue; 
                    }
                }

                if (hex.damage > 0) {
                    let isMelted = hex.damage >= this.config.breakThreshold * 0.85;
                    let baseRepair = isMelted ? (this.config.baseRepairRate / 1.25) : this.config.baseRepairRate;
                    
                    let structuralIntegrity = isMainland ? Math.max(0, Math.min(1.0, intactTouches / 3.0)) : 0.0;
                    let repairRate = baseRepair * structuralIntegrity;
                    
                    hex.damage = Math.max(0, hex.damage - (repairRate * powerSupplyEfficiency));
                    
                    let normalizedPower = hex.damage / this.config.breakThreshold;
                    if (normalizedPower > 0.88 && !hex.isHoleRim && hex.conduitPath < 0.5 && isMainland) {
                        powerSources.push({ hex: hex, power: Math.min(10.0, Math.pow(Math.max(0, normalizedPower), 4) * 2.5), isImpact: false });
                        hex.isSource = true;
                    }
                }
            }
        }

        if (brokenCells.length > 0) {
            let conduits = new Map();
            let conduitHoleSizes = new Map();
            let conduitThinness = new Map(); 

            for (let brokenHex of brokenCells) {
                let hSize = holeSizesMap.get(brokenHex) || 1; 
                let thinness = brokenCellThinness.get(brokenHex.id) || 1.0;
                for (let n of this.getNeighbors(brokenHex.id)) {
                    if (!n.isBroken) { 
                        conduits.set(n.id, (conduits.get(n.id) || 0) + 1); 
                        n.isHoleRim = true; 
                        conduitHoleSizes.set(n.id, Math.max(conduitHoleSizes.get(n.id) || 0, hSize));
                        conduitThinness.set(n.id, Math.max(conduitThinness.get(n.id) || 0, thinness));
                    }
                }
            }
            
            for (let [conduitId, brokenTouches] of conduits.entries()) {
                let conduitHex = this.grid.get(conduitId);
                let hSize = conduitHoleSizes.get(conduitId) || 1;
                let localThinness = conduitThinness.get(conduitId) || 1.0;
                
                let healFactor = Math.max(0.15, 12.0 / (hSize + 4.0)) * localThinness;
                
                let secondDegreeDamage = 0; let count = 0;
                for (let n of this.getNeighbors(conduitHex.id)) {
                    if (!n.isBroken) {
                        for (let nn of this.getNeighbors(n.id)) {
                            if (!nn.isBroken && !nn.isHoleRim) { secondDegreeDamage += nn.damage; count++; }
                        }
                    }
                }
                let avgSecondDegree = count > 0 ? secondDegreeDamage / count : 0;
                
                let recededThreshold = 5.8 - (this.globalTension * 1.5);
                let intactTouches = conduitHex.neighbors.length - brokenTouches;
                let notchFactor = Math.pow(Math.max(0, intactTouches - 2.5), 2.0); 
                let arcProbability = 0.015 + (notchFactor * 0.025) + (localThinness * 0.035);

                if (avgSecondDegree < recededThreshold || Math.random() < arcProbability) {
                    let holdDampener = 1.0 - (conduitHex.holdSuppression || 0);
                    let initialPower = (0.4 + (healFactor * 1.2) + (notchFactor * 0.6) + (this.globalTension * 1.5)) * holdDampener; 
                    
                    if (initialPower > 0.2) {
                        powerSources.push({ hex: conduitHex, power: initialPower, hSize: hSize, healFactor: healFactor, isImpact: false, notchFactor: notchFactor });
                        conduitHex.isSource = true;
                    }
                }
            }
        }

        for (let id of this.activeTouches) {
            let hex = this.grid.get(id);
            if (hex && !hex.isBroken) {
                let damageRatio = Math.max(0, Math.min(1.0, hex.damage / this.config.breakThreshold));
                let arcSuppression = (hex.isHoleRim || damageRatio > 0.85) ? 0.0 : 1.0; 
                let touchPower = (0.8 + (damageRatio * 1.2)) * arcSuppression; 
                
                if (touchPower > 0.1) {
                    let fakeHSize = 1.0 + (damageRatio * 6.0); 
                    powerSources.push({ 
                        hex: hex, 
                        power: touchPower, 
                        hSize: fakeHSize, 
                        healFactor: 0.1, 
                        isImpact: true,
                        notchFactor: 0 
                    });
                    hex.isSource = true;
                }
            }
        }

        if (powerSources.length > 0) {
            let queue = []; let visited = new Map();
            for (let src of powerSources) { 
                visited.set(src.hex.id, src.power); 
                queue.push({hex: src.hex, dist: 1, power: src.power, hSize: src.hSize, healFactor: src.healFactor, isImpact: src.isImpact, notchFactor: src.notchFactor || 0}); 
            }
            
            let iterations = 0; 
            while(queue.length > 0 && iterations < 3500) {
                iterations++;
                let {hex, dist, power, hSize, healFactor, isImpact, notchFactor} = queue.shift();
                
                let scorchMultiplier = isImpact ? 0.15 : (1.0 + this.globalTension * 2.0);
                let scorchDamage = power * scorchMultiplier;
                
                if (!hex.isBroken) hex.damage = Math.max(hex.damage, Math.min(7.5, scorchDamage));
                hex.brightness = Math.max(hex.brightness || 0, power);
                
                let conduitBoost = isImpact ? power * 0.8 : power * 0.5;
                hex.conduitPath = Math.min(3.0, hex.conduitPath + conduitBoost);
                
                let calculatedRadius = 2.0 + (hSize * 0.5) + (power * 1.2) + (notchFactor * 1.0) + (healFactor * 4.0) + (this.globalTension * 4.0) + (Math.random() * 4.0); 
                let baseDrawRadius = Math.min(18.0, calculatedRadius); 
                
                if (dist < baseDrawRadius && power > 0.1) {
                    let validNeighbors = [];
                    for (let n of this.getNeighbors(hex.id)) {
                        if (!n.isBroken && !n.isSource) {
                            let intactCount = 0; let damagePenalty = n.damage * 2.5; 
                            for (let nn of this.getNeighbors(n.id)) { if (!nn.isBroken) intactCount++; damagePenalty += nn.damage * 0.5; }
                            let memoryFactor = 4.0 + (this.globalTension * 8.0);
                            let noiseFactor = 6.0 * (1.0 - this.globalTension * 0.85);
                            let score = (n.conduitPath * memoryFactor) + (intactCount * 2.0) - damagePenalty + (Math.random() * noiseFactor);
                            validNeighbors.push({ hex: n, score: score });
                        }
                    }
                    if (validNeighbors.length > 0) {
                        validNeighbors.sort((a, b) => b.score - a.score);
                        let fluctuation = (Math.random() * 0.7 * (1.0 - this.globalTension * 0.8)) * (0.4 + (dist / baseDrawRadius));
                        let retention = Math.max(0.1, (0.95 + this.globalTension * 0.04) - fluctuation); 
                        let mainPower = power * retention * 0.9; 
                        
                        if (!visited.has(validNeighbors[0].hex.id) || mainPower > visited.get(validNeighbors[0].hex.id)) {
                            visited.set(validNeighbors[0].hex.id, mainPower); 
                            queue.push({hex: validNeighbors[0].hex, dist: dist + 1, power: mainPower, hSize, healFactor, isImpact, notchFactor});
                        }
                        if (validNeighbors.length > 1 && power > 0.6 && Math.random() > 0.5) {
                            let secPower = power * retention * 0.5; 
                            if (!visited.has(validNeighbors[1].hex.id) || secPower > visited.get(validNeighbors[1].hex.id)) {
                                visited.set(validNeighbors[1].hex.id, secPower); 
                                queue.push({hex: validNeighbors[1].hex, dist: dist + 1, power: secPower, hSize, healFactor, isImpact, notchFactor});
                            }
                        }
                    }
                }
            }
        }

        if (brokenCells.length > 0) {
            let totalRepairRequested = 0;
            let repairRequests = [];

            for (let brokenHex of brokenCells) {
                let intactNeighbors = [];
                let validGridConnections = 0;
                
                for (let n of this.getNeighbors(brokenHex.id)) {
                    if (!n.isBroken && mainlandSet.has(n.id)) {
                        intactNeighbors.push(n);
                        let nIntactTouches = 0;
                        for (let nn of this.getNeighbors(n.id)) if (!nn.isBroken) nIntactTouches++;
                        if (nIntactTouches >= 2) validGridConnections++; 
                    }
                }
                
                if (intactNeighbors.length > 0 && validGridConnections > 0) {
                    let branchPowerSupplied = 0;
                    for (let n of intactNeighbors) { branchPowerSupplied += n.conduitPath; n.conduitPath *= 0.25; }
                    
                    let hSize = holeSizesMap.get(brokenHex) || 1; 
                    let thinness = brokenCellThinness.get(brokenHex.id) || 1.0;
                    
                    let baseHealFactor = Math.max(0.15, 12.0 / (hSize + 4.0));
                    
                    let topologyMultiplier = Math.pow(intactNeighbors.length / 2.0, 2.0); 
                    let healFactor = baseHealFactor * topologyMultiplier * thinness;
                    
                    let requested = (0.0012 + branchPowerSupplied * 0.045) * healFactor;
                    totalRepairRequested += requested;
                    repairRequests.push({ hex: brokenHex, requested: requested, neighbors: intactNeighbors, healFactor: healFactor });
                }
            }

            let distributionMultiplier = 1.0;
            if (totalRepairRequested > dynamicRepairBudget) {
                distributionMultiplier = dynamicRepairBudget / totalRepairRequested;
            }
            
            let finalRepairMultiplier = distributionMultiplier * powerSupplyEfficiency;

            for (let req of repairRequests) {
                let actualHeal = req.requested * finalRepairMultiplier;
                req.hex.rebuildProgress += actualHeal;
                
                let glowIntensity = Math.min(1.0, (actualHeal * 25.0) + (req.healFactor * 0.15));
                req.hex.healGlow = Math.max(req.hex.healGlow || 0, glowIntensity);
                
                let audioObj = hexToAudioData.get(req.hex.id);
                if (audioObj) audioObj.healSpike += actualHeal;

                for (let n of req.neighbors) {
                    n.healGlow = Math.max(n.healGlow || 0, glowIntensity);
                }

                if (req.hex.rebuildProgress >= 1.0) {
                    req.hex.isBroken = false; 
                    req.hex.rebuildProgress = 0; 
                    req.hex.damage = this.config.breakThreshold - 0.1; 
                }
            }
        }
        
        let totalArcPower = 0;
        for (let hex of this.grid.values()) {
            if (!hex.isBroken) {
                if (hex.damage > 0) hex.brightness = Math.max(hex.brightness, (hex.damage / this.config.breakThreshold) * 0.85);
                totalArcPower += (hex.conduitPath || 0);
            }
        }
        this.currentArcPower = totalArcPower;
    }

    updateInstancedMesh() {
        const dummy = new THREE.Object3D(); 
        const tempColor = new THREE.Color();
        const opacityAttr = this.instancedMesh.geometry.attributes.instanceOpacity;

        let logStress = Math.max(0, Math.min(1.0, this.shieldStress || 0));
        
        const currentBase = new THREE.Color();
        const currentGlow = new THREE.Color();
        const currentPeak = new THREE.Color();

        if (logStress < 0.3) {
            let t = Math.max(0, Math.min(1.0, logStress / 0.3));
            t = t * t * (3.0 - 2.0 * t); 
            currentBase.copy(this.config.colorHealthyBase).lerp(this.config.colorMidBase, t || 0);
            currentGlow.copy(this.config.colorHealthyGlow).lerp(this.config.colorMidGlow, t || 0);
            currentPeak.copy(this.config.colorHealthyPeak).lerp(this.config.colorMidPeak, t || 0);
        } else {
            let t = Math.max(0, Math.min(1.0, (logStress - 0.3) / 0.7));
            t = Math.pow(t, 1.5);
            currentBase.copy(this.config.colorMidBase).lerp(this.config.colorStressedBase, t || 0);
            currentGlow.copy(this.config.colorMidGlow).lerp(this.config.colorStressedGlow, t || 0);
            currentPeak.copy(this.config.colorMidPeak).lerp(this.config.colorStressedPeak, t || 0);
        }

        for (let hex of this.grid.values()) {
            dummy.position.set(hex.x, hex.y, hex.z);
            
            if (hex.isBroken) { 
                dummy.scale.set(0, 0, 0); 
            } else {
                dummy.scale.set(this.config.hexGap, this.config.hexGap, 1);
            }
            
            dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(hex.x, hex.y, hex.z).normalize());
            dummy.rotateZ((Math.PI / 3) * (hex.id % 2));
            dummy.updateMatrix(); 
            
            this.instancedMesh.setMatrixAt(hex.id, dummy.matrix);
            
            if (!hex.isBroken) {
                let healIntensity = Math.max(0, Math.min(1.0, hex.healGlow || 0));
                let damageIntensity = Math.max(0, hex.damage / this.config.breakThreshold);
                
                let coreFlicker = 1.0;
                let brightnessFlicker = 1.0;
                let isGlitchingRim = false;
                
                let starvation = Math.max(0, this.globalTension || 0); 
                let fractureTopology = Math.abs(Math.sin(hex.x * 0.08) * Math.cos(hex.y * 0.08) * Math.sin(hex.z * 0.08));
                
                if (hex.isHoleRim) {
                    let instability = Math.max(0, (damageIntensity * 0.8) + (starvation * 0.25) + (fractureTopology * 0.6) - (healIntensity * 1.5));
                    let baseFailProb = (damageIntensity * 0.4) + (starvation * 0.15); 
                    let holeSizeFactor = Math.min(2.0, (hex.localHoleSize || 1) / 15.0);
                    let irregularPenalty = fractureTopology * holeSizeFactor * 0.4;
                    
                    let rawFailProb = Math.max(0, baseFailProb + irregularPenalty - (healIntensity * 0.6));
                    let halfLitProb = Math.min(0.85, Math.pow(rawFailProb, 1.8));
                    
                    if (Math.random() < halfLitProb) {
                        isGlitchingRim = true;
                        coreFlicker = 0.0;
                        brightnessFlicker = 0.15 + (Math.random() * 0.25);
                    } 
                    else if (Math.random() < Math.min(0.8, instability * 0.4)) {
                        isGlitchingRim = true;
                        coreFlicker = 0.0; 
                        let swing = Math.min(0.8, instability * 0.5); 
                        brightnessFlicker = (1.0 + Math.random() * 0.4) - (Math.random() * swing);
                    } 
                    else {
                        coreFlicker = 1.0; 
                        brightnessFlicker = 0.85 + Math.random() * 0.3 + (healIntensity * 0.4); 
                    }
                } else if (damageIntensity > 0.0) {
                    let instability = Math.max(0, (damageIntensity * 1.2) + (starvation * 0.1) + (fractureTopology * 0.4) - (healIntensity * 1.0));
                    
                    if (Math.random() < Math.min(0.7, instability * 0.3)) {
                        coreFlicker = Math.random() < Math.min(0.8, instability * 0.5) ? 0.0 : 1.0; 
                        let dimDepth = Math.min(0.7, instability * 0.4);
                        brightnessFlicker = 1.0 - (Math.random() * dimDepth);
                    }
                }

                let rimBrightness = 0.8 + (damageIntensity * 0.4) + (healIntensity * 0.8);
                let localBrightness = Math.max(damageIntensity, hex.brightness) + (healIntensity * 0.35);
                let effectiveBrightness = hex.isHoleRim ? Math.max(rimBrightness, localBrightness + 0.1) : localBrightness;
                
                effectiveBrightness *= brightnessFlicker;

                let visualIntensity = Math.pow(Math.max(0, Math.min(1.0, effectiveBrightness)), 1.4);
                visualIntensity = isNaN(visualIntensity) ? 0 : visualIntensity;
                
                let cellOpacity = Math.max(0, Math.min(1.0, visualIntensity * 6.6));
                cellOpacity *= coreFlicker;
                opacityAttr.setX(hex.id, cellOpacity);

                if (visualIntensity < 0.35) {
                    let localT = Math.max(0, Math.min(1.0, visualIntensity / 0.35));
                    tempColor.copy(currentBase).lerp(currentGlow, localT || 0);
                } else {
                    let localT = Math.max(0, Math.min(1.0, (visualIntensity - 0.35) / 0.65));
                    tempColor.copy(currentGlow).lerp(currentPeak, localT || 0);
                }
                
                let finalOverdrive = 0;
                let holdDampener = 1.0 - (hex.holdSuppression || 0) * 0.85; 
                
                if (hex.isHoleRim) {
                    finalOverdrive = (isGlitchingRim ? 0.8 : 2.8) * holdDampener; 
                } else {
                    let tensionBoost = starvation * 0.4;
                    let branchIntensity = Math.min(1.5, hex.brightness); 
                    let branchKick = branchIntensity * (0.5 + tensionBoost);
                    let overdriveStrength = 0.25 + branchKick + (healIntensity * 0.4);
                    finalOverdrive = Math.min(1.5, Math.pow(Math.max(0, effectiveBrightness), 1.5) * overdriveStrength) * holdDampener;
                }
                
                tempColor.multiplyScalar(1.0 + (isNaN(finalOverdrive) ? 0 : finalOverdrive));
                this.instancedMesh.setColorAt(hex.id, tempColor);
            }
        }
        this.instancedMesh.instanceMatrix.needsUpdate = true; 
        this.instancedMesh.instanceColor.needsUpdate = true;
        opacityAttr.needsUpdate = true;
    }

    loop() {
        this.shieldGroup.rotation.y += this.shieldVelocity.y;
        this.shieldGroup.rotation.x += this.shieldVelocity.x;
        
        if (this.shieldDragPointerId === null) {
            this.shieldVelocity.x *= 0.95;
            this.shieldVelocity.y *= 0.95; 
        }

        this.applyInteractionDamage(); 
        this.updateLogic(); 
        this.updateInstancedMesh();
        
        const isTouching = this.activeTouches.size > 0;
        
        if (isTouching) {
            this.touchSustain = 1.0; 
            let tx = 0;
            let tDmg = 0;
            for (let id of this.activeTouches) {
                let hex = this.grid.get(id);
                if (hex) {
                    tx += hex.x;
                    tDmg += hex.damage / this.config.breakThreshold;
                }
            }
            this.lastTouchPan = (tx / this.activeTouches.size) / this.config.sphereRadius;
            this.lastTouchPan = Math.max(-1, Math.min(1, this.lastTouchPan));
            this.lastTouchDamage = Math.max(0, Math.min(1.0, tDmg / this.activeTouches.size));
        } else {
            this.touchSustain = (this.touchSustain || 0) * 0.85; 
        }
        
        // Smooth the frame damage delta into a continuous envelope for the audio engine
        this.damageSpike = (this.damageSpike || 0) * 0.8 + (this.frameDamageDelta || 0) * 0.2;
        
        // Push all new topological data channels into the synthesizer
        this.audio.update(this.globalTension, this.shieldStress, this.holeAudioData, this.currentArcPower || 0, this.touchSustain || 0, this.lastTouchPan || 0, this.lastTouchDamage || 0, this.damageSpike || 0, this.ambientDamage || 0);
        
        this.composer.render(); 
        requestAnimationFrame(this.loop);
    }
}

const initApp = () => { new HexShieldSphere(document.getElementById('canvas-container')); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();
