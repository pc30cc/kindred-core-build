# dmgbuild settings for the Webyar installer window: the app and a link to
# /Applications side by side over a drawn background (background.swift).
# Values come from make-dmg.sh through -D app=… background=… icon=…
import os

app = defines['app']
files = [app]
symlinks = {'Applications': '/Applications'}
icon = defines.get('icon')
background = defines['background']

format = 'UDZO'
filesystem = 'HFS+'
window_rect = ((200, 140), (660, 440))
default_view = 'icon-view'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 112
text_size = 13
hide_extensions = [os.path.basename(app)]
icon_locations = {
    os.path.basename(app): (170, 205),
    'Applications': (490, 205),
}
