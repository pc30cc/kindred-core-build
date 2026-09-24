import SwiftUI

/// Liquid Glass, and what this app draws when the OS has never heard of it.
///
/// iOS 26 gave SwiftUI a real material. `glassEffect` renders a lens that
/// refracts and brightens whatever scrolls underneath it, and a
/// `GlassEffectContainer` lets neighbouring pieces of that lens merge and
/// separate as they move. It is the system's visual language now, and an app
/// that ignores it reads as though it were written for a different phone.
///
/// This app's deployment target is iOS 17, so none of it can simply be
/// called. Every use goes through this file, which answers the same three
/// questions once instead of at every call site:
///
///   * Is the real material available? Use it, and let Apple own the look.
///   * Is it not? Draw the closest honest approximation — a system material,
///     an edge that catches light from above, and a shadow that lifts the
///     surface off the page. Deliberate, not degraded.
///   * Has the reader asked for less transparency? Then draw neither. They
///     get an opaque surface with a real border. Glass is decoration;
///     legibility is not negotiable.
///
/// Because the branch lives here, a screen writes `.liquidGlass(.card, in:)`
/// and never learns which iOS it is running on.
///
/// ## Where glass belongs
///
/// On chrome that content moves underneath: the tab bar, a toolbar, a
/// composer pinned over a transcript, a sheet's grabber area. Nowhere else.
///
/// This is not a matter of taste. A lens works by refracting what is behind
/// it, so over an opaque page at rest it has nothing to bend and renders as a
/// pale smear -- and a smear is a terrible thing to put a label on. The queue
/// chips and the search field were both built on glass first and both lost
/// their own text to it. They are inline rows on a still page, so they use
/// `Theme.Palette.surface` with a hairline instead, which is what an inline
/// control on iOS has always looked like.
///
/// The same reasoning rules out glass on glass. A tinted lens laid on the
/// tab bar's lens was muddy, and it left the selected tab's blue icon on a
/// blue surface. One glass surface, and a solid indicator on top of it.

// MARK: - Roles

/// What a glass surface is *for*, rather than what it is made of.
///
/// Call sites name the role; this file decides the material, the edge and the
/// shadow. That is what stops a card on one screen and a card on the next
/// from drifting into two slightly different greys.
enum GlassRole {
    /// Chrome that content slides beneath — the tab bar, a floating header.
    /// The thinnest material, because the whole point is to see movement
    /// through it.
    case chrome
    /// A panel raised off the page: a card, a grouped section, a sheet.
    case card
    /// A small interactive element — a pill button, a filter chip, an icon
    /// in a circle.
    case control
}

private extension GlassRole {
    /// The pre-26 stand-in. Thinner for chrome so scrolling still shows
    /// through; heavier for a card, which is meant to sit *on* the page
    /// rather than float over it.
    var material: Material {
        switch self {
        case .chrome: return .ultraThinMaterial
        case .card: return .regularMaterial
        case .control: return .thinMaterial
        }
    }

    /// How hard the top edge catches light. Chrome floats highest, so it
    /// catches the most.
    var sheen: Double {
        switch self {
        case .chrome: return 0.55
        case .card: return 0.38
        case .control: return 0.45
        }
    }

    var elevation: Theme.Elevation {
        switch self {
        case .chrome: return .floating
        case .card: return .raised
        case .control: return .resting
        }
    }
}

// MARK: - The modifier

private struct LiquidGlassSurface<S: InsettableShape>: ViewModifier {
    let role: GlassRole
    let shape: S
    let tint: Color?
    let isInteractive: Bool

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        if reduceTransparency {
            opaque(content)
        } else if #available(iOS 26.0, *) {
            // Apple's material already draws its own edge and its own
            // shadow. Adding ours on top is how a surface ends up with two
            // borders and a dirty halo, so on 26 we add nothing at all.
            content.glassEffect(glass, in: shape)
        } else {
            legacy(content)
        }
    }

    // MARK: iOS 26+

    @available(iOS 26.0, *)
    private var glass: Glass {
        var g: Glass = .regular
        if let tint { g = g.tint(tint) }
        // `interactive` is what makes the lens flex and bounce under a
        // finger. It belongs on things that take a tap and on nothing else:
        // a header that squishes when you touch it looks broken.
        if isInteractive { g = g.interactive() }
        return g
    }

    // MARK: iOS 17–25

    /// Material, sheen, edge, shadow — in that order, because each one is
    /// drawn over the last.
    private func legacy(_ content: Content) -> some View {
        content
            .background {
                shape.fill(role.material)
            }
            .background {
                // A tint under the material rather than over it, so the blur
                // still reads as blur and the colour as the colour of the
                // thing behind the glass.
                if let tint {
                    shape.fill(tint.opacity(scheme == .dark ? 0.22 : 0.16))
                }
            }
            .overlay {
                // The sheen: brightest along the top edge, gone by the
                // middle. This is the single cheapest thing that makes a flat
                // material look like a solid with a surface.
                shape.fill(
                    LinearGradient(
                        colors: [
                            .white.opacity(scheme == .dark ? 0.06 : 0.28),
                            .white.opacity(0),
                        ],
                        startPoint: .top,
                        endPoint: .center
                    )
                )
                .allowsHitTesting(false)
            }
            .overlay {
                shape.strokeBorder(edge, lineWidth: 0.75)
                    .allowsHitTesting(false)
            }
            .compositingGroup()
            .elevated(role.elevation)
    }

    /// A lit top edge fading to a dark bottom one — the same trick a real
    /// bevel plays, and what keeps the shape's outline visible against both
    /// a white list and a dark photo.
    private var edge: LinearGradient {
        LinearGradient(
            colors: scheme == .dark
                ? [.white.opacity(role.sheen * 0.34), .white.opacity(0.04)]
                : [.white.opacity(role.sheen), Theme.Palette.separator.opacity(0.28)],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // MARK: Reduce Transparency

    /// No blur, no sheen, no translucency — a flat surface and a border firm
    /// enough to define it. This is what the setting is asking for.
    private func opaque(_ content: Content) -> some View {
        content
            .background {
                shape.fill(tint.map { $0.opacity(scheme == .dark ? 0.30 : 0.14) } ?? Theme.Palette.surface)
            }
            .overlay {
                shape.strokeBorder(Theme.Palette.separator, lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .elevated(role.elevation)
    }
}

extension View {
    /// Draws this view on a piece of Liquid Glass.
    ///
    /// - Parameters:
    ///   - role: what the surface is for. Picks the material and the lift.
    ///   - shape: the outline. Anything insettable — `Capsule()`,
    ///     `RoundedRectangle(cornerRadius:style:)`, `Circle()`.
    ///   - tint: a colour the glass takes on. Use it for the one selected or
    ///     primary thing on screen, never for decoration.
    ///   - interactive: `true` only when the view itself takes a tap.
    func liquidGlass<S: InsettableShape>(
        _ role: GlassRole,
        in shape: S,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        modifier(LiquidGlassSurface(role: role, shape: shape, tint: tint, isInteractive: interactive))
    }

    /// The common case: a capsule.
    func liquidGlass(
        _ role: GlassRole,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        liquidGlass(role, in: Capsule(style: .continuous), tint: tint, interactive: interactive)
    }

    /// The other common case: a rounded rectangle at one of the theme's radii.
    func liquidGlass(
        _ role: GlassRole,
        cornerRadius: CGFloat,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        liquidGlass(
            role,
            in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous),
            tint: tint,
            interactive: interactive
        )
    }
}

// MARK: - Grouping

/// Neighbouring glass that behaves like one body of liquid.
///
/// Inside a container, two glass shapes closer together than `spacing` merge
/// into a single blob and pull apart again as they move — which is what makes
/// the system's own tab bar feel like a substance rather than a row of
/// buttons. Below iOS 26 there is nothing to group, so this is the content
/// itself and costs nothing.
struct LiquidGlassGroup<Content: View>: View {
    var spacing: CGFloat = Theme.Space.md
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

// MARK: - Buttons

/// The system's glass button on 26, and a capsule that reads the same way
/// before it.
///
/// Kept as a modifier rather than a `ButtonStyle` because `.glass` and
/// `.bordered` are different concrete types and a `ButtonStyle` cannot return
/// one of two without erasing both.
extension View {
    @ViewBuilder
    func liquidGlassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if prominent {
                buttonStyle(.glassProminent).buttonBorderShape(.capsule)
            } else {
                buttonStyle(.glass).buttonBorderShape(.capsule)
            }
        } else {
            if prominent {
                buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
            } else {
                buttonStyle(.bordered).buttonBorderShape(.capsule)
            }
        }
    }
}

// MARK: - Edges

/// Lets a scroll view's top edge dissolve into the chrome above it on iOS 26,
/// where the system draws a soft falloff instead of a hard line.
///
/// A no-op before 26, where the floating chrome carries its own material and
/// there is nothing to blend into.
extension View {
    @ViewBuilder
    func softScrollEdges() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }
}

// MARK: - Bars

/// A bar pinned to an edge of the screen: the composer over a transcript.
///
/// Not `liquidGlass(.chrome, in: Rectangle())` -- a bar reaches the screen's
/// own edges, so a stroke all the way round it would draw three borders
/// nobody asked for. This is fill plus a single hairline on the edge that
/// faces the content, which is the only edge a bar actually has.
struct GlassBar: ViewModifier {
    /// Which side the content is on.
    var edge: VerticalEdge = .top

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        content
            .background {
                if reduceTransparency {
                    Theme.Palette.surface
                } else if #available(iOS 26.0, *) {
                    Rectangle().fill(.clear).glassEffect(.regular, in: Rectangle())
                } else {
                    // `.bar` is the system's own bar material and already
                    // the right answer before 26.
                    Rectangle().fill(.bar)
                }
            }
            .overlay(alignment: edge == .top ? .top : .bottom) {
                Divider().opacity(0.6)
            }
    }
}

extension View {
    func glassBar(edge: VerticalEdge = .top) -> some View {
        modifier(GlassBar(edge: edge))
    }
}
