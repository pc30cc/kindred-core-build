import SwiftUI

/// A message bubble, with a beak at the foot of the last one in a run.
///
/// The beak is what ties a bubble to the face beside it. Only the last bubble
/// of a run gets one — the same bubble that gets the avatar — because a tail
/// on every bubble turns a quiet column of messages into a sawtooth.
///
/// Which side it points to is a physical question, not a reading-order one:
/// the operator sits on the right of the transcript in every language, so the
/// caller passes `pointsRight` directly rather than leaving it to
/// `\.layoutDirection`. The shape is built with the beak on the right and
/// mirrored about the middle when it belongs on the left, so the two sides are
/// the same curve rather than two hand-fitted ones.
struct ChatBubble: Shape {
    /// How far the beak reaches past the body of the bubble.
    ///
    /// The caller pads the content by this much on the beak's side, so the
    /// last word never sits underneath it.
    static let beak: CGFloat = 6

    var radius: CGFloat = Theme.Radius.xl
    var hasBeak: Bool = false
    var pointsRight: Bool = true

    /// Never mirrored by the reading direction.
    ///
    /// This is the whole fix for a beak that pointed away from the avatar in
    /// Persian. SwiftUI mirrors a `Shape` under a right-to-left layout
    /// direction by default, which is right for an arrow or a chevron and
    /// wrong for this: `pointsRight` is already a physical answer, so letting
    /// the system flip it on top undoes the decision.
    ///
    /// The text bubble escaped the bug by accident — `chatBubble` pins the
    /// direction to LTR for the sake of its padding, and the shape rode along.
    /// A photo goes through `chatBubbleClip`, which has no padding to pin, so
    /// its beak flipped and the text beside it did not. Declaring the
    /// behaviour here fixes every use at once: clip, fill and background.
    var layoutDirectionBehavior: LayoutDirectionBehavior { .fixed }

    func path(in rect: CGRect) -> Path {
        guard hasBeak else {
            let r = min(radius, min(rect.width, rect.height) / 2)
            return Path(roundedRect: rect, cornerRadius: r, style: .continuous)
        }

        return beakedPath(in: rect)
    }

    /// Built with the beak on the right; mirrored in place when it is not.
    private func beakedPath(in rect: CGRect) -> Path {
        var p = Path()
        let body = rect.width - Self.beak
        let r = max(0, min(radius, min(body, rect.height) / 2))
        let right = rect.minX + body

        p.move(to: CGPoint(x: rect.minX, y: rect.midY))
        // Top-left, then top-right.
        p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY),
                 tangent2End: CGPoint(x: rect.midX, y: rect.minY), radius: r)
        p.addArc(tangent1End: CGPoint(x: right, y: rect.minY),
                 tangent2End: CGPoint(x: right, y: rect.midY), radius: r)
        // Down the right edge, then out into the beak and back along the foot.
        p.addLine(to: CGPoint(x: right, y: rect.maxY - r))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.maxY),
                       control: CGPoint(x: right, y: rect.maxY - r * 0.15))
        p.addQuadCurve(to: CGPoint(x: right - r, y: rect.maxY),
                       control: CGPoint(x: right - r * 0.3, y: rect.maxY))
        // Bottom-left, and the left edge closes it.
        p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY),
                 tangent2End: CGPoint(x: rect.minX, y: rect.midY), radius: r)
        p.closeSubpath()

        if pointsRight { return p }
        // x ↦ 2·midX − x: the same curve, hinged on the bubble's centre line.
        return p.applying(CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 2 * rect.midX, ty: 0))
    }
}

extension View {
    /// Draws this view as a message bubble filled with `color`, reserving room
    /// for the beak when there is one.
    func chatBubble(
        _ fill: some ShapeStyle,
        radius: CGFloat = Theme.Radius.xl,
        hasBeak: Bool,
        pointsRight: Bool
    ) -> some View {
        // The padding is physical, like the beak: `.trailing` would follow the
        // language and put the gap on the wrong side of a Persian bubble.
        padding(pointsRight ? .trailing : .leading, hasBeak ? ChatBubble.beak : 0)
            .background(
                ChatBubble(radius: radius, hasBeak: hasBeak, pointsRight: pointsRight)
                    .fill(fill)
            )
            .environment(\.layoutDirection, .leftToRight)
    }

    /// Clips this view to the same outline — for a photo, which is its own
    /// bubble rather than something drawn inside one.
    func chatBubbleClip(
        radius: CGFloat = Theme.Radius.lg,
        hasBeak: Bool,
        pointsRight: Bool
    ) -> some View {
        let shape = ChatBubble(radius: radius, hasBeak: hasBeak, pointsRight: pointsRight)
        return clipShape(shape).contentShape(shape)
    }
}
