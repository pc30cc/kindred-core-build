package com.webyar.operator.feature.contacts

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.SearchState
import com.webyar.operator.ui.components.rememberSearchState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ContactsTest {

    @get:Rule val compose = createComposeRule()

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun model() = ContactsViewModel(SampleApi()) { Language.FA }

    private fun ids(state: ContactsState) =
        (state as ContactsState.Loaded).contacts.map { it.id }

    // MARK: - The model

    @Test
    fun `binding loads the address book`() = runTest(dispatcher) {
        val contacts = model()
        contacts.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("p-1", "p-2", "p-3", "p-4", "p-5"), ids(contacts.state.value))
    }

    @Test
    fun `search reaches the name, the address, the number and the code`() = runTest(dispatcher) {
        val contacts = model()
        contacts.bind("ws-1")
        testScheduler.advanceUntilIdle()

        contacts.setQuery("مریم")
        assertEquals(listOf("p-1"), ids(contacts.state.value))

        contacts.setQuery("EMRE@EXAMPLE.COM")
        assertEquals(listOf("p-4"), ids(contacts.state.value))

        // The only handle an anonymous visitor has.
        contacts.setQuery("8f2c")
        assertEquals(listOf("p-3"), ids(contacts.state.value))

        // A phone number, which no other field carries.
        contacts.setQuery("989121234567")
        assertEquals(listOf("p-5"), ids(contacts.state.value))
    }

    @Test
    fun `clearing the search puts everyone back`() = runTest(dispatcher) {
        val contacts = model()
        contacts.bind("ws-1")
        testScheduler.advanceUntilIdle()

        contacts.setQuery("مریم")
        contacts.setQuery("")
        assertEquals(5, ids(contacts.state.value).size)
    }

    @Test
    fun `the detail screen reads the row the list already has`() = runTest(dispatcher) {
        val contacts = model()
        contacts.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals("Emre Yılmaz", contacts.contact("p-4")?.name)
        // And says so rather than inventing one it never saw.
        assertEquals(null, contacts.contact("nope"))
    }

    @Test
    fun `visitor intel arrives keyed by contact`() = runTest(dispatcher) {
        val contacts = model()
        contacts.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals("Windows", contacts.intel.value["p-1"]?.device?.os)
    }

    // MARK: - The screens

    @Test
    fun `the list draws a row per contact`() = runTest {
        val all = SampleApi().contacts("ws-1")
        compose.setContent { ContactsScreen(ContactsState.Loaded(all), Language.FA, {}) }

        compose.onNodeWithTag(A11y.CONTACTS_LIST).assertIsDisplayed()
        compose.onNodeWithTag(A11y.contactRow("p-1")).assertIsDisplayed()
        compose.onNodeWithTag(A11y.contactRow("p-3")).assertIsDisplayed()
    }

    @Test
    fun `tapping a row opens it`() = runTest {
        val all = SampleApi().contacts("ws-1")
        var opened: String? = null
        compose.setContent {
            ContactsScreen(ContactsState.Loaded(all), Language.FA, { opened = it.id })
        }
        compose.onNodeWithTag(A11y.contactRow("p-2")).performClick()
        compose.waitForIdle()

        assertEquals("p-2", opened)
    }

    @Test
    fun `an empty address book says so`() {
        compose.setContent { ContactsScreen(ContactsState.Loaded(emptyList()), Language.FA, {}) }

        compose.onNodeWithTag(A11y.CONTACTS_EMPTY).assertIsDisplayed()
        compose.onNodeWithText(Str.contactsEmptyTitle(Language.FA)).assertIsDisplayed()
    }

    /**
     * "Nobody has written in yet" and "your search found nobody" are not the
     * same news, and the screen used to give the first answer to both.
     */
    @Test
    fun `a search that finds nobody says that, not that the book is empty`() {
        lateinit var search: SearchState
        compose.setContent {
            search = rememberSearchState()
            ContactsScreen(
                ContactsState.Loaded(emptyList()),
                Language.FA,
                {},
                search = search,
            )
        }
        // After composition, not during it: `rememberSearchState` clears the
        // terms on its first pass, and writing state from inside a composable
        // is how you get a value that is read once and then thrown away.
        compose.runOnIdle { search.text = "zzzz" }

        compose.onNodeWithText(Str.noResults(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `the detail screen lists only the facts a contact has`() = runTest {
        val anonymous = SampleApi().contacts("ws-1").first { it.id == "p-3" }
        compose.setContent { ContactDetailScreen(anonymous, Language.EN) }

        compose.onNodeWithTag(A11y.CONTACT_DETAIL).assertIsDisplayed()
        // It has a code and a first-seen date, and no address or number, so
        // there is no blank row where either would have been.
        compose.onNodeWithText("8F2C").assertIsDisplayed()
        compose.onNodeWithText("First seen").assertIsDisplayed()
        compose.onNodeWithText(Str.emailLabel(Language.EN)).assertDoesNotExist()
    }

    @Test
    fun `a detail screen whose contact is gone does not crash`() {
        // Reachable: the list is dropped on a workspace change while a detail
        // screen is still on the back stack.
        compose.setContent { ContactDetailScreen(null, Language.FA) }
        compose.onNodeWithText(Str.contactsEmptyTitle(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `a phone-only contact shows the number and not an empty address`() = runTest {
        val phoneOnly = SampleApi().contacts("ws-1").first { it.id == "p-5" }
        compose.setContent { ContactDetailScreen(phoneOnly, Language.EN) }

        compose.onNodeWithText("+989121234567").assertIsDisplayed()
        compose.onNodeWithText("Phone").assertIsDisplayed()
        assertTrue(phoneOnly.email == null)
    }
}
