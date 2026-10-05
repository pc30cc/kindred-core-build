import SwiftUI
import MapKit

/// Where the visitors are: a dot per visitor, coloured by presence, over a
/// quiet map — the desktop apps' map, drawn with MapKit.
///
/// No user location, ever. The map shows where the *visitors* are; the
/// operator's own position is nobody's business here, so there is no
/// `UserAnnotation`, no location button, and nothing that could make iOS ask
/// for a permission the app has no reason to hold.
struct VisitorsMapView: View {
    let model: VisitorsViewModel
    /// A dot was tapped: open that visitor.
    let open: (String) -> Void

    @Environment(AppState.self) private var appState
    @State private var position: MapCameraPosition = .automatic
    /// The camera is framed on the first markers once, then left to the
    /// operator — re-framing on every refresh would yank the map away from
    /// wherever they had moved it.
    @State private var framed = false

    private var language: Language { appState.language }

    var body: some View {
        let markers = model.markers
        Map(position: $position) {
            ForEach(markers) { marker in
                Annotation(
                    marker.place,
                    coordinate: CLLocationCoordinate2D(latitude: marker.latitude, longitude: marker.longitude),
                    anchor: .center
                ) {
                    Button {
                        open(marker.id)
                    } label: {
                        VisitorMapDot(presence: marker.presence)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accessibilityLabel(for: marker))
                }
                .annotationTitles(.hidden)
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControls {
            MapCompass()
            MapScaleView()
        }
        // The numbers ride over the top of the map, the "without a location"
        // line over the bottom — above the floating tab bar, which the map
        // runs underneath.
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.phase == .loaded {
                VisitorStatsStrip(model: model, language: language)
                    .padding(.horizontal, Theme.screenInset)
                    .padding(.vertical, Theme.Space.sm)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if model.unplacedCount > 0 {
                    Label(
                        VisitorFormat.count(Str.visitorsWithoutLocation(language), model.unplacedCount, language: language),
                        systemImage: "mappin.slash"
                    )
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.vertical, Theme.Space.sm)
                    .background(Capsule().fill(.regularMaterial))
                    .padding(.bottom, Theme.Space.sm)
                }
                Color.clear.frame(height: Theme.Size.floatingBarClearance)
            }
        }
        .overlay {
            if model.phase == .loading {
                ProgressView()
                    .controlSize(.large)
                    .padding(Theme.Space.xl)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).fill(.regularMaterial))
            }
        }
        .onAppear { frame(markers) }
        .onChange(of: markers.map(\.id)) { _, _ in frame(model.markers) }
    }

    /// Frames every marker once, never closer than about a country, so a
    /// single visitor does not land the map on their street.
    private func frame(_ markers: [VisitorMapMarker]) {
        guard !framed, !markers.isEmpty else { return }
        framed = true
        let lats = markers.map(\.latitude), lngs = markers.map(\.longitude)
        guard let minLat = lats.min(), let maxLat = lats.max(), let minLng = lngs.min(), let maxLng = lngs.max() else { return }
        let span = MKCoordinateSpan(
            latitudeDelta: min(170, max(12, (maxLat - minLat) * 1.4)),
            longitudeDelta: min(360, max(12, (maxLng - minLng) * 1.4))
        )
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2)
        position = .region(MKCoordinateRegion(center: center, span: span))
    }

    private func accessibilityLabel(for marker: VisitorMapMarker) -> String {
        let place = marker.place.isEmpty ? Str.visitorsUnknownLocation(language) : marker.place
        return "\(place), \(VisitorFormat.presence(marker.presence, language: language))"
    }
}

/// A visitor on the map: green with a soft halo when on the page, amber when
/// idle, grey when gone. Big enough to hit with a thumb.
private struct VisitorMapDot: View {
    let presence: VisitorPresence

    var body: some View {
        ZStack {
            if presence == .online {
                Circle()
                    .fill(Theme.Palette.success.opacity(0.24))
                    .frame(width: 28, height: 28)
            }
            Circle()
                .fill(PresenceDot.color(presence))
                .frame(width: 14, height: 14)
                .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
        }
        .frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
        .contentShape(Circle())
    }
}
