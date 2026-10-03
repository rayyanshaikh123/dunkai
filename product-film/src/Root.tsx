import { Composition, Folder } from "remotion";
import { Film } from "./Composition";
import { SignalFilm } from "./signal/Film";
import { SignalScenes } from "./signal/Registrations";
import { Opening } from "./Opening";
import { Prompt } from "./Prompt";
import { Architecture } from "./Architecture";
import { Components } from "./Components";
import { PCB } from "./PCB";
import { Firmware } from "./Firmware";
import { Finale } from "./Finale";
export const RemotionRoot = () => (
  <>
    <SignalScenes />
    <Composition
      id="DunkAI-Signal-4K"
      component={SignalFilm}
      width={3840}
      height={2160}
      fps={60}
      durationInFrames={1920}
    />
    <Composition
      id="DunkAI-Launch-4K"
      component={Film}
      width={3840}
      height={2160}
      fps={60}
      durationInFrames={2010}
    />
    <Folder name="Scenes">
      <Composition
        id="Opening"
        component={Opening}
        width={1920}
        height={1080}
        fps={60}
        durationInFrames={300}
      />
      <Composition
        id="Prompt"
        component={Prompt}
        width={1920}
        height={1080}
        fps={60}
        durationInFrames={330}
      />
      <Composition
        id="Architecture"
        component={Architecture}
        width={1920}
        height={1080}
        fps={60}
        durationInFrames={270}
      />
      <Composition
        id="Components-BOM"
        component={Components}
        width={1920}
        height={1080}
        fps={60}
        durationInFrames={360}
      />
      <Composition
        id="PCB"
        component={PCB}
        width={1920}
        height={1080}
        fps={60}
        durationInFrames={330}
      />
      <Composition
        id="Firmware"
        component={Firmware}
        width={1920}
        height={1080}
        fps={60}
        durationInFrames={300}
      />
      <Composition
        id="Finale"
        component={Finale}
        width={1920}
        height={1080}
        fps={60}
        durationInFrames={300}
      />
    </Folder>
  </>
);
