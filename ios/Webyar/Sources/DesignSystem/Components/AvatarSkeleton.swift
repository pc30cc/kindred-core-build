import SwiftUI

/// What stands where a face will be: a silhouette — head and shoulders — in
/// the skeleton's greys.
///
/// It is the only thing an avatar shows in place of a picture, whether the
/// picture is on its way or there is none. It replaced initials, which were
/// wrong twice over. While a picture loads, a letter looks like the answer,
/// so its swap for a photograph reads as the row changing its mind. And with
/// no picture at all, a pair of letters on a colour picked by hash is a
/// second, made-up identity for somebody — "SK" on teal — that the operator
/// then learns and has to unlearn the day a photograph arrives.
///
/// The silhouette is the same shape in both cases, so a picture that turns
/// out not to exist costs nothing to look at: the sweep stops and the shape
/// stays. A picture that does arrive fades in over it (`RemoteImage`).
struct AvatarSkeleton: View {
    /// Who the picture is of, which decides the figure: a person's head and
    /// shoulders, or a building for a workspace's logo.
    enum Subject {
        case person
        case organisation
    }

    var subject: Subject = .person
    /// A picture is on its way: the silhouette carries the skeleton's sweep.
    var isLoading = false

    var body: some View {
        if isLoading {
            silhouette.skeletonSweep()
        } else {
            silhouette
        }
    }

    private var silhouette: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            ZStack {
                Theme.Palette.skeletonBase
                figure(side)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .accessibilityHidden(true)
    }

    /// Proportioned like the system's own contact placeholder: a head a
    /// little above the centre, a clear gap for the neck, and shoulders that
    /// run out of the circle rather than ending inside it.
    @ViewBuilder
    private func figure(_ side: CGFloat) -> some View {
        switch subject {
        case .person:
            ZStack {
                Circle()
                    .frame(width: side * 0.38, height: side * 0.38)
                    .offset(y: -side * 0.10)
                Ellipse()
                    .frame(width: side * 0.80, height: side * 0.60)
                    .offset(y: side * 0.46)
            }
            .foregroundStyle(figureFill)
        case .organisation:
            Image(systemName: "building.2.fill")
                .font(.system(size: side * 0.40))
                .foregroundStyle(figureFill)
        }
    }

    /// A touch lighter at the top: the same soft top-light the OS marks
    /// carry, which is what keeps a flat shape from looking cut out.
    private var figureFill: LinearGradient {
        LinearGradient(
            colors: [Theme.Palette.skeletonFigure.opacity(0.8), Theme.Palette.skeletonFigure],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}
