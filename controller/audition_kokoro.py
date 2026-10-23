"""Generate Kokoro → RVC clips with final-audio lip sync, without an LLM."""

import argparse
import asyncio
import json
from pathlib import Path
import time

from controller.speech import ApplioSettings, ApplioWorker, ROOT, Segment, synthesise


async def audition(args) -> None:
    settings = ApplioSettings(tts_provider='kokoro', kokoro_voice=args.voice,
                             kokoro_speed=args.speed, kokoro_threads=args.threads,
                             rvc_threads=args.rvc_threads)
    settings.check()
    worker = ApplioWorker(settings)
    directory = args.output_dir.resolve()
    results = []
    try:
        ready = await worker.start()
        print(json.dumps({'worker': ready, 'kokoro': worker.kokoro.ready}), flush=True)
        for text in args.text or ['Good evening! I am ready to keep you company.',
                                  'We can test my new local voice together.']:
            started = time.perf_counter()
            clip, metrics = await synthesise(Segment(text, 'soft-smile', 0.6), worker,
                                             'kokoro-audition', directory)
            result = {'text': text, 'audio': str(directory / f'{clip}.wav'),
                      'visemes': str(directory / f'{clip}.visemes.json'),
                      'wallSeconds': round(time.perf_counter() - started, 3), **metrics}
            results.append(result)
            print(json.dumps(result), flush=True)
    finally:
        await worker.close()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'results.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--text', action='append')
    parser.add_argument('--voice', default='af_heart')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--rvc-threads', type=int, default=4)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'assets/private/speech/kokoro-audition')
    asyncio.run(audition(parser.parse_args()))


if __name__ == '__main__':
    main()
