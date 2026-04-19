export type Vec2 = { x: number; y: number };

/**
 * A single rigged image. The bone's image is positioned so its `pivot`
 * pixel lands at the `joint` coordinate of its parent's image. Rotation
 * happens around the pivot. Root bones have parent === null and joint is
 * interpreted as an offset from skeleton.origin.
 */
export type Bone = {
  id: string;
  parent: string | null;
  joint: Vec2;
  pivot: Vec2;
  image: string;
  rest: number;
  z: number;
};

export type Skeleton = {
  name: string;
  frameSize: number;
  origin: Vec2;
  bones: Bone[];
};

export type Keyframe = {
  t: number;
  rot?: Record<string, number>;
};

export type Animation = {
  name: string;
  frames: number;
  fps: number;
  loop: boolean;
  keyframes: Keyframe[];
};

export type AnimationsManifest = {
  animations: string[];
};
