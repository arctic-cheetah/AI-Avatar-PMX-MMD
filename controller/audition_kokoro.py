"""Generate Kokoro → RVC clips with final-audio lip sync, without an LLM."""

import argparse
import asyncio
import json
from pathlib import Path
import time
import wave

from controller.speech import ApplioSettings, ApplioWorker, ROOT, Segmenter, synthesise


def join_wavs(paths: list[Path], output: Path) -> None:
    """Concatenate same-format WAV clips into ``output``."""
    with wave.open(str(output), 'wb') as joined:
        for index, path in enumerate(paths):
            with wave.open(str(path), 'rb') as clip:
                if index == 0:
                    joined.setparams(clip.getparams())
                joined.writeframes(clip.readframes(clip.getnframes()))


async def audition(args) -> None:
    settings = ApplioSettings(tts_provider='kokoro', kokoro_voice=args.voice,
                             kokoro_speed=args.speed, kokoro_threads=args.threads,
                             kokoro_clause_pause=args.clause_pause,
                             sentence_tail=args.sentence_tail, fragment_tail=args.fragment_tail,
                             mood_prosody=args.mood_prosody,
                             punctuation_cadence=args.punctuation_cadence,
                             ellipsis_tail=args.ellipsis_tail, exclaim_tail=args.exclaim_tail,
                             question_tail=args.question_tail, exclaim_gain=args.exclaim_gain,
                             emphasis=args.emphasis, emphasis_pause=args.emphasis_pause,
                             interjection_contours=args.interjection_contours,
                             interjection_bend=args.interjection_bend,
                             rvc_threads=args.rvc_threads)
    settings.check()
    worker = ApplioWorker(settings)
    directory = args.output_dir.resolve()
    results = []
    try:
        ready = await worker.start()
        print(json.dumps({'worker': ready, 'kokoro': worker.kokoro.ready}), flush=True)
        texts = args.text or ['Good evening! I am ready to keep you company.',
                              'We can test my new local voice together.']
        settings_used = {'voice': args.voice, 'speed': args.speed,
                         'clausePause': args.clause_pause, 'sentenceTail': args.sentence_tail,
                         'fragmentTail': args.fragment_tail, 'moodProsody': args.mood_prosody,
                         'punctuationCadence': args.punctuation_cadence,
                         'emphasis': args.emphasis,
                         'interjectionContours': args.interjection_contours}
        for mood, weight in args.mood or [('soft-smile', 0.6)]:
            for number, text in enumerate(texts, 1):
                # Split like the live bridge, so each sentence gets its own clip and tail.
                segmenter = Segmenter(expression=mood, weight=weight)
                segments = segmenter.feed({'type': 'say', 'text': text}) + segmenter.finish()
                clips = []
                for segment in segments:
                    started = time.perf_counter()
                    clip, metrics = await synthesise(segment, worker, 'kokoro-audition', directory)
                    clips.append(directory / f'{clip}.wav')
                    result = {'text': text, 'segment': segment.text, 'mood': mood, 'weight': weight,
                              'audio': str(clips[-1]),
                              'visemes': str(directory / f'{clip}.visemes.json'),
                              'wallSeconds': round(time.perf_counter() - started, 3), **metrics,
                              'settings': settings_used}
                    results.append(result)
                    print(json.dumps(result), flush=True)
                # One readable file per line, its clips back to back as the renderer plays them.
                join_wavs(clips, directory / f'{mood}-{weight:g}-{number}.wav')
    finally:
        await worker.close()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'results.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')


def mood_arg(value: str) -> tuple[str, float]:
    """Parse ``name`` or ``name:weight`` (weight 0–1) for --mood."""
    name, _, weight = value.partition(':')
    if not name.replace('-', '').isalnum():
        raise argparse.ArgumentTypeError(f'invalid mood name: {name!r}')
    try:
        number = float(weight) if weight else 1.0
    except ValueError:
        raise argparse.ArgumentTypeError(f'invalid mood weight: {weight!r}') from None
    if not 0.0 <= number <= 1.0:
        raise argparse.ArgumentTypeError('mood weight must be between 0 and 1')
    return name, number


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--text', action='append')
    parser.add_argument('--voice', default='af_heart:0.7,af_bella:0.3')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--clause-pause', type=float, default=0.25)
    parser.add_argument('--sentence-tail', type=float, default=0.4)
    parser.add_argument('--fragment-tail', type=float, default=0.1)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--rvc-threads', type=int, default=4)
    parser.add_argument('--mood', type=mood_arg, action='append',
                        help='Mood for every --text, as name or name:weight; repeat to compare.')
    parser.add_argument('--punctuation-cadence', action='store_true',
                        help='Per-ending gaps, louder !, slower ellipses, dashes as pauses.')
    parser.add_argument('--ellipsis-tail', type=float, default=0.6)
    parser.add_argument('--exclaim-tail', type=float, default=0.3)
    parser.add_argument('--question-tail', type=float, default=0.4)
    parser.add_argument('--exclaim-gain', type=float, default=3.0)
    parser.add_argument('--emphasis', action='store_true', help='Pause before *word* emphasis.')
    parser.add_argument('--emphasis-pause', type=float, default=0.12)
    parser.add_argument('--interjection-contours', action='store_true',
                        help='Rise-then-fall pitch contour on "Aww"/"Ooh".')
    parser.add_argument('--interjection-bend', type=float, default=4.0)
    parser.add_argument('--mood-prosody', action='store_true',
                        help='Apply mood-driven speed, pauses and RVC pitch.')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'assets/private/speech/kokoro-audition')
    asyncio.run(audition(parser.parse_args()))


if __name__ == '__main__':
    main()
