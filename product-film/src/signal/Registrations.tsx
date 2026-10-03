import { Composition, Folder } from "remotion";
import { Genesis, Idea } from "./Genesis";
import { System, Matter } from "./System";
import { Physical } from "./Physical";
import { Logic, Resolve } from "./Resolve";
export const SignalScenes = () => (
  <Folder name="Signal-scenes">
    <Composition
      id="Signal-Genesis"
      component={Genesis}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={190}
    />
    <Composition
      id="Signal-Idea"
      component={Idea}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={240}
    />
    <Composition
      id="Signal-System"
      component={System}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={240}
    />
    <Composition
      id="Signal-Matter"
      component={Matter}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={270}
    />
    <Composition
      id="Signal-Physical"
      component={Physical}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={360}
    />
    <Composition
      id="Signal-Logic"
      component={Logic}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={270}
    />
    <Composition
      id="Signal-Resolve"
      component={Resolve}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={350}
    />
  </Folder>
);
