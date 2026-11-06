// SPDX-License-Identifier: MIT
import { IconButton } from './components/IconButton.js';
import { useRoute } from './route.js';
import { TopAppBar } from './shell/TopAppBar.js';
import { useTheme } from './shell/theme.js';
import { VideoList } from './shell/VideoList.js';
import { VideoPage } from './shell/VideoPage.js';

/** Mirage's page: the video list at `#/`, a video's tabs at `#/v/<n>/<tab>`. */
export function App() {
  const route = useRoute();
  const [theme, toggleTheme] = useTheme();
  const themeButton = (
    <IconButton
      icon={theme === 'dark' ? 'light_mode' : 'dark_mode'}
      aria-label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
      onClick={toggleTheme}
    />
  );
  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), document.getElementById('main')?.focus())}>
        Skip to the page
      </a>
      {route.page === 'video' ? (
        <VideoPage key={route.video} video={route.video} tab={route.tab} trailing={themeButton} />
      ) : (
        <>
          <TopAppBar title={<span className="brand">Mirage</span>} trailing={themeButton} />
          <VideoList />
        </>
      )}
    </>
  );
}
