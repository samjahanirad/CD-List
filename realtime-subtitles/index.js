/**
 * Realtime Subtitles CD
 *
 * Captures audio from the active browser tab and transcribes it in real-time
 * using Deepgram's speech-to-text API. Displays live English subtitles as a
 * draggable overlay panel on the page.
 *
 * Requirements:
 *   - A Deepgram API key (free tier available at console.deepgram.com)
 *   - The tab must be playing audio
 *
 * Usage:
 *   1. Set your Deepgram API key via the gear icon in CD-Driver
 *   2. Navigate to a page with audio (YouTube, SoundCloud, etc.)
 *   3. Click "Get Data" to prepare
 *   4. Click "Run CD" to start subtitles
 *   5. Click "Run CD" again to stop
 */

function DataCollector(currentUrl) {
  var result = {
    timestamp: Date.now(),
    pageUrl: currentUrl || '',
    message: ''
  };

  if (!currentUrl) {
    result.error = 'No URL provided. Make sure you have a webpage open.';
    return result;
  }

  result.message = 'Ready to start real-time subtitles.\n\n'
    + 'Page: ' + currentUrl + '\n\n'
    + 'This will capture audio from the current tab and transcribe it '
    + 'using Deepgram AI (English only).\n\n'
    + 'Requirements:\n'
    + '  - Deepgram API key (set via gear icon)\n'
    + '  - Tab must be playing audio\n\n'
    + 'Click "Run CD" to start. Click again to stop.';

  return result;
}

function Run(data) {
  if (!data) {
    return { success: false, error: 'No data. Click "Get Data" first.' };
  }

  if (data.error) {
    return { success: false, error: data.error };
  }

  return {
    success: true,
    action: 'start_subtitles',
    pageUrl: data.pageUrl,
    message: 'Starting real-time subtitles...'
  };
}
